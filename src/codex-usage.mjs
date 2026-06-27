#!/usr/bin/env node
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HttpError } from "./http.mjs";

const AUTH_PATH = process.env.PI_AUTH || join(homedir(), ".pi", "agent", "auth.json");
const AUTH_KEY = process.env.PI_AUTH_KEY || "openai-codex";
const USER_AGENT = process.env.CODEX_USAGE_USER_AGENT || "codex-usage/0";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const ENDPOINTS = [
  "https://chatgpt.com/backend-api/wham/usage",
  "https://chatgpt.com/api/codex/usage",
];
const REQUEST_TIMEOUT_MS = 18_000;

function decodeJwtPayload(token) {
  try {
    const payload = token?.split(".")[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function pickFirst(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0) || "";
}

async function readJson(path) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch (error) {
    throw new HttpError(500, `Failed to read Codex auth: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function loadAuth() {
  if (!existsSync(AUTH_PATH)) {
    throw new HttpError(404, `Pi auth file not found: ${AUTH_PATH}. Run pi auth, or set PI_AUTH.`);
  }

  const auth = await readJson(AUTH_PATH);
  const credential = auth[AUTH_KEY];
  if (!credential) throw new HttpError(401, `Missing ${AUTH_KEY} in ${AUTH_PATH}`);

  const accessToken = pickFirst(credential.access, credential.access_token);
  const accessPayload = decodeJwtPayload(accessToken);
  const accountId = pickFirst(
    credential.accountId,
    credential.account_id,
    accessPayload?.[JWT_AUTH_CLAIM]?.chatgpt_account_id,
  );

  if (!accessToken) throw new HttpError(401, `Missing Codex access token in ${AUTH_PATH}:${AUTH_KEY}`);
  if (!accountId) throw new HttpError(401, `Missing ChatGPT account id in ${AUTH_PATH}:${AUTH_KEY}`);
  if (accessPayload?.exp && accessPayload.exp * 1000 <= Date.now()) {
    throw new HttpError(401, "Codex auth token is expired; please re-login with pi auth");
  }

  return { accessToken, accountId };
}

async function fetchUsageFrom(endpoint, auth) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(endpoint, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        "ChatGPT-Account-Id": auth.accountId,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchUsage(auth) {
  let lastError = "";

  for (const endpoint of ENDPOINTS) {
    try {
      const response = await fetchUsageFrom(endpoint, auth);
      if (response.status === 401 || response.status === 403) {
        throw new HttpError(401, "Codex auth token is unavailable or expired; please re-login with Codex");
      }
      if (!response.ok) {
        lastError = `${endpoint} returned HTTP ${response.status}`;
        continue;
      }
      return await response.json();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      lastError = `${endpoint}: ${error?.name === "AbortError" ? "request timed out" : error instanceof Error ? error.message : String(error)}`;
    }
  }

  throw new HttpError(502, `Failed to fetch Codex usage${lastError ? ` (${lastError})` : ""}`);
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function windowSeconds(window) {
  return toNumber(window?.limit_window_seconds ?? window?.windowDurationMins * 60);
}

function usedPercent(window) {
  return toNumber(window?.used_percent ?? window?.usedPercent);
}

function resetAt(window) {
  return toNumber(window?.reset_at ?? window?.resets_at ?? window?.resetsAt);
}

function collectWindows(payload) {
  const windows = [payload?.rate_limit?.primary_window, payload?.rate_limit?.secondary_window];
  for (const item of payload?.additional_rate_limits || []) {
    windows.push(item?.rate_limit?.primary_window, item?.rate_limit?.secondary_window);
  }
  return windows.filter((window) => window
    && windowSeconds(window) !== null
    && usedPercent(window) !== null
    && resetAt(window) !== null);
}

function nearestWindow(windows, targetSeconds) {
  return windows.reduce((best, window) => {
    if (!best) return window;
    return Math.abs(windowSeconds(window) - targetSeconds) < Math.abs(windowSeconds(best) - targetSeconds) ? window : best;
  }, null);
}

function windowLabel(seconds) {
  if (seconds % 604800 === 0) return `${Math.floor(seconds / 604800)}w`;
  if (seconds % 86400 === 0) return `${Math.floor(seconds / 86400)}d`;
  if (seconds % 3600 === 0) return `${Math.floor(seconds / 3600)}h`;
  if (seconds % 60 === 0) return `${Math.floor(seconds / 60)}m`;
  return `${seconds}s`;
}

function utc8(timestampSeconds) {
  const date = new Date((timestampSeconds + 8 * 3600) * 1000);
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC+8`;
}

function formatWindow(window) {
  const seconds = windowSeconds(window);
  const used = usedPercent(window);
  const reset = resetAt(window);
  return {
    label: windowLabel(seconds),
    seconds,
    usedPercent: used,
    resetAt: reset,
    resetText: utc8(reset),
    text: `${windowLabel(seconds)}: ${used}% used, reset ${utc8(reset)}`,
  };
}

function formatUsage(payload) {
  const windows = collectWindows(payload);
  if (windows.length === 0) return [];

  const selected = [nearestWindow(windows, 5 * 60 * 60), nearestWindow(windows, 7 * 24 * 60 * 60)].filter(Boolean);
  const seen = new Set();
  return selected
    .filter((window) => {
      const seconds = windowSeconds(window);
      if (seen.has(seconds)) return false;
      seen.add(seconds);
      return true;
    })
    .map(formatWindow);
}

export async function readCodexUsage() {
  const auth = await loadAuth();
  const payload = await fetchUsage(auth);
  const windows = formatUsage(payload);
  if (windows.length === 0) throw new HttpError(502, "No Codex usage windows in response");
  return { windows, updatedAt: new Date().toISOString() };
}

async function main() {
  try {
    const usage = await readCodexUsage();
    console.log(usage.windows.map((window) => window.text).join("\n"));
  } catch (error) {
    console.error(`codex-usage: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(error instanceof HttpError && error.status >= 400 && error.status < 500 ? 1 : 2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
