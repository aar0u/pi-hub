import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { rootDir } from "./config.mjs";

const DATA_DIR = join(rootDir, "data");
const TASKS_PATH = join(DATA_DIR, "tasks.json");
const RUNS_PATH = join(DATA_DIR, "task-runs.jsonl");

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readJsonFile(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonFile(path, value) {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tmp, path);
}

function newId(prefix = "task") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeTask(task) {
  return {
    id: task.id,
    prompt: task.prompt,
    cron: task.cron,
    source: task.source || "web",
    status: task.status || "enabled",
    confirmed: Boolean(task.confirmed),
    createdAt: task.createdAt || new Date().toISOString(),
    updatedAt: task.updatedAt || new Date().toISOString(),
    lastRunAt: task.lastRunAt || null,
    lastRunKey: task.lastRunKey || null,
    lastResult: task.lastResult || null,
    dueAt: task.dueAt || null,
    telegramChatId: task.telegramChatId || null,
    cwd: task.cwd || null,
    sessionFile: task.sessionFile || null,
    sessionId: task.sessionId || null,
    sessionName: task.sessionName || null,
  };
}

export class TaskStore {
  static async open() {
    await ensureDataDir();
    const store = new TaskStore();
    await store.load();
    return store;
  }

  async load() {
    const data = await readJsonFile(TASKS_PATH, { tasks: [] });
    this.tasks = Array.isArray(data.tasks) ? data.tasks.map(normalizeTask) : [];
  }

  async save() {
    await writeJsonFile(TASKS_PATH, { version: 1, tasks: this.tasks.map(normalizeTask) });
  }

  list() {
    return [...this.tasks].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  get(id) {
    return this.tasks.find((task) => task.id === id) || null;
  }

  async create({ prompt, cron, source = "web", confirmed = true, status = "enabled", telegramChatId = null, cwd = null, sessionFile = null, sessionId = null, sessionName = null }) {
    const now = new Date().toISOString();
    const task = normalizeTask({ id: newId(), prompt, cron, source, confirmed, status, telegramChatId, cwd, sessionFile, sessionId, sessionName, createdAt: now, updatedAt: now });
    this.tasks.push(task);
    await this.save();
    return task;
  }

  async update(id, patch) {
    const task = this.get(id);
    if (!task) return null;
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    await this.save();
    return normalizeTask(task);
  }

  async delete(id) {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((task) => task.id !== id);
    if (this.tasks.length === before) return false;
    await this.save();
    return true;
  }

  async appendRun(run) {
    await ensureDataDir();
    await fs.appendFile(RUNS_PATH, `${JSON.stringify({ id: newId("run"), ...run })}\n`);
  }

  async listRuns(taskId, limit = 50) {
    let text = "";
    try {
      text = await fs.readFile(RUNS_PATH, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    return text.split("\n")
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((run) => run && (!taskId || run.taskId === taskId))
      .slice(-limit)
      .reverse();
  }
}

export { DATA_DIR, TASKS_PATH, RUNS_PATH };
