import { HttpError, readBody, sendJson } from "../http.mjs";
import { assertCron, nextCronRun } from "../cron.mjs";
import { createTaskProposal } from "../task-proposal.mjs";

function assertTaskInput(body, { partial = false } = {}) {
  const out = {};
  if (!partial || "prompt" in body) {
    if (typeof body.prompt !== "string" || !body.prompt.trim()) throw new HttpError(400, "Task prompt is empty");
    out.prompt = body.prompt.trim();
  }
  if (!partial || "cron" in body) out.cron = assertCron(body.cron);
  return out;
}

function taskPayload(task) {
  return { ...task, nextRunAt: task.status === "enabled" && task.confirmed ? nextCronRun(task.cron) : null };
}

function sessionBinding(state) {
  return {
    cwd: state?.cwd || null,
    sessionFile: state?.sessionFile || null,
    sessionId: state?.sessionId || null,
    sessionName: state?.sessionName || null,
  };
}

export function registerTasksRoutes(apiRoutes, { taskStore, promptRunner, currentState }) {
  apiRoutes.set("GET /api/tasks", async (_req, res, _url) => {
    sendJson(res, { tasks: taskStore.list().map(taskPayload), runs: await taskStore.listRuns(null, 20) });
  });

  apiRoutes.set("POST /api/tasks", async (req, res, _url) => {
    const input = assertTaskInput(await readBody(req));
    const task = await taskStore.create({ ...input, source: "web", confirmed: true, status: "enabled", ...sessionBinding(currentState()) });
    sendJson(res, { task: taskPayload(task), tasks: taskStore.list().map(taskPayload) }, 201);
  });

  apiRoutes.set("POST /api/tasks/propose", async (req, res, _url) => {
    const body = await readBody(req);
    if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, "Task request is empty");
    const proposal = await createTaskProposal({
      text: body.text,
      source: "web",
      taskStore,
      run: (input) => promptRunner.runText(input),
    });
    sendJson(res, { ...proposal, task: proposal.task ? taskPayload(proposal.task) : null, tasks: taskStore.list().map(taskPayload) }, proposal.task ? 201 : 200);
  });

  apiRoutes.set("PATCH /api/tasks", async (req, res, _url) => {
    const body = await readBody(req);
    if (typeof body.id !== "string") throw new HttpError(400, "Missing task id");
    const patch = assertTaskInput(body, { partial: true });
    if (body.status !== undefined) {
      if (!["enabled", "disabled"].includes(body.status)) throw new HttpError(400, "Invalid task status");
      patch.status = body.status;
    }
    if (body.confirmed !== undefined) patch.confirmed = Boolean(body.confirmed);
    if ((patch.confirmed || patch.status === "enabled") && !taskStore.get(body.id)?.sessionFile) Object.assign(patch, sessionBinding(currentState()));
    const task = await taskStore.update(body.id, patch);
    if (!task) throw new HttpError(404, "Task not found");
    sendJson(res, { task: taskPayload(task), tasks: taskStore.list().map(taskPayload) });
  });

  apiRoutes.set("DELETE /api/tasks", async (_req, res, url) => {
    const id = url.searchParams.get("id");
    if (!id) throw new HttpError(400, "Missing task id");
    if (!(await taskStore.delete(id))) throw new HttpError(404, "Task not found");
    sendJson(res, { ok: true, tasks: taskStore.list().map(taskPayload) });
  });
}
