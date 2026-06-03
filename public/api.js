import { apiAuthHeaders } from "./stream.js";

export const BACKEND_OFFLINE_MESSAGE = "Backend disconnected. Restart it, then refresh if this does not recover.";

export function isNetworkError(err) {
  return err instanceof TypeError || (err instanceof DOMException && err.name === "AbortError");
}

export async function api(path, options = {}) {
  const { headers, ...fetchOptions } = options;
  let res;
  try {
    res = await fetch(path, {
      ...fetchOptions,
      headers: { "content-type": "application/json", ...apiAuthHeaders(), ...(headers || {}) },
    });
  } catch (err) {
    if (isNetworkError(err)) throw new Error(BACKEND_OFFLINE_MESSAGE);
    throw err;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || res.statusText);
  return data;
}

export async function responseError(res) {
  const error = await res.json().catch(() => ({}));
  return new Error(error.error || `Request failed: ${res.status}`);
}
