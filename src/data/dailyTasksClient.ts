import type { TodayTask } from "@/types";
import { timeoutSignal } from "@/data/timeoutSignal";

export interface DailyTasksSnapshot {
  date: string;
  tasks: TodayTask[];
  hash: string | null;
  updatedAt: string | null;
  notFound?: boolean;
}

export class DailyTasksApiError extends Error {
  status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "DailyTasksApiError";
    this.status = status;
  }
}

export class DailyTasksNotFoundError extends DailyTasksApiError {
  constructor() {
    super("今天还没有任务文件", 404);
    this.name = "DailyTasksNotFoundError";
  }
}

export class DailyTasksConflictError extends DailyTasksApiError {
  snapshot: DailyTasksSnapshot;

  constructor(snapshot: DailyTasksSnapshot) {
    super("Obsidian 中的任务已被外部修改", 409);
    this.name = "DailyTasksConflictError";
    this.snapshot = snapshot;
  }
}

function isTodayTask(value: unknown): value is TodayTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Record<string, unknown>;
  return (
    typeof task.id === "string" &&
    typeof task.title === "string" &&
    typeof task.done === "boolean" &&
    (task.linkId === null || typeof task.linkId === "string") &&
    (task.linkType === null || [
      "topic",
      "content",
      "content-review",
      "account-breakdown",
      "daily-review",
      "task",
    ].includes(String(task.linkType))) &&
    ((task.linkId === null) === (task.linkType === null))
  );
}

function parseSnapshot(raw: unknown): DailyTasksSnapshot {
  if (!raw || typeof raw !== "object") {
    throw new DailyTasksApiError("服务返回了无法识别的数据");
  }

  const value = raw as Record<string, unknown>;
  if (
    typeof value.date !== "string" ||
    !Array.isArray(value.tasks) ||
    !value.tasks.every(isTodayTask) ||
    !(typeof value.hash === "string" || value.hash === null) ||
    !(typeof value.updatedAt === "string" || value.updatedAt === null) ||
    !(value.notFound === undefined || typeof value.notFound === "boolean")
  ) {
    throw new DailyTasksApiError("服务返回的今日任务格式不正确");
  }

  return value as unknown as DailyTasksSnapshot;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new DailyTasksApiError("服务返回了无法读取的响应", response.status);
  }
}

export async function getDailyTasks(signal?: AbortSignal): Promise<DailyTasksSnapshot> {
  let response: Response;
  try {
    response = await fetch("/api/daily-tasks", { signal: timeoutSignal(8_000, signal), cache: "no-store" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new DailyTasksApiError("无法连接保存服务，请稍后重试");
  }

  if (response.status === 404) throw new DailyTasksNotFoundError();
  if (!response.ok) {
    throw new DailyTasksApiError(`读取失败（${response.status}）`, response.status);
  }
  const snapshot = parseSnapshot(await readJson(response));
  if (snapshot.notFound) throw new DailyTasksNotFoundError();
  return snapshot;
}

export async function putDailyTasks(
  tasks: TodayTask[],
  expectedHash: string | null
): Promise<DailyTasksSnapshot> {
  let response: Response;
  try {
    response = await fetch("/api/daily-tasks", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tasks: tasks.map(({ id, title, done, linkId, linkType }) => ({ id, title, done, linkId, linkType })),
        expectedHash,
      }),
    });
  } catch {
    throw new DailyTasksApiError("无法连接保存服务，当前改动尚未保存");
  }

  const raw = await readJson(response);
  if (response.status === 409) {
    const conflict = raw as Record<string, unknown>;
    const snapshot = conflict.current ?? conflict.snapshot ?? raw;
    throw new DailyTasksConflictError(parseSnapshot(snapshot));
  }
  if (!response.ok) {
    const rawMessage = raw && typeof raw === "object"
      ? (raw as Record<string, unknown>).message ?? (raw as Record<string, unknown>).error
      : null;
    const message = typeof rawMessage === "string" ? rawMessage : `保存失败（${response.status}）`;
    throw new DailyTasksApiError(message, response.status);
  }
  return parseSnapshot(raw);
}
