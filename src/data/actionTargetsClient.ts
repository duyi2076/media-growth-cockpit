import type { ActionTargetId } from "@/types";
import { timeoutSignal } from "@/data/timeoutSignal";

export interface EditableActionTarget {
  id: ActionTargetId;
  target: number | null;
}

export interface ActionTargetsSnapshot {
  targets: EditableActionTarget[];
  campaignStartedAt: string | null;
  hash: string;
  updatedAt: string;
}

export class ActionTargetsApiError extends Error {
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ActionTargetsApiError";
    this.status = status;
  }
}

export class ActionTargetsConflictError extends ActionTargetsApiError {
  snapshot: ActionTargetsSnapshot;
  constructor(snapshot: ActionTargetsSnapshot) {
    super("Obsidian 中的行动目标已被外部修改", 409);
    this.name = "ActionTargetsConflictError";
    this.snapshot = snapshot;
  }
}

const orderedIds: ActionTargetId[] = [
  "article-output",
  "video-output",
  "platform-publish",
  "content-review",
  "account-breakdown",
];
const ids = new Set<ActionTargetId>(orderedIds);

function parseSnapshot(raw: unknown): ActionTargetsSnapshot {
  if (!raw || typeof raw !== "object") throw new ActionTargetsApiError("目标服务返回了无法识别的数据");
  const value = raw as Record<string, unknown>;
  const targetRows = Array.isArray(value.targets) ? value.targets : [];
  const receivedIds = targetRows.map((item) => item && typeof item === "object" ? (item as Record<string, unknown>).id : null);
  if (
    !Array.isArray(value.targets)
    || value.targets.length !== 5
    || !value.targets.every((item) => {
      if (!item || typeof item !== "object") return false;
      const row = item as Record<string, unknown>;
      return typeof row.id === "string"
        && ids.has(row.id as ActionTargetId)
        && (row.target === null || (typeof row.target === "number" && Number.isInteger(row.target) && row.target > 0 && row.target <= 1_000_000));
    })
    || new Set(receivedIds).size !== orderedIds.length
    || orderedIds.some((id) => !receivedIds.includes(id))
    || !(value.campaignStartedAt === null || (typeof value.campaignStartedAt === "string" && !Number.isNaN(Date.parse(value.campaignStartedAt))))
    || typeof value.hash !== "string"
    || typeof value.updatedAt !== "string"
  ) {
    throw new ActionTargetsApiError("目标服务返回的数据格式不正确");
  }
  return value as unknown as ActionTargetsSnapshot;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ActionTargetsApiError("目标服务返回了无法读取的响应", response.status);
  }
}

export async function getActionTargets(signal?: AbortSignal): Promise<ActionTargetsSnapshot> {
  let response: Response;
  try {
    response = await fetch("/api/action-targets", { signal: timeoutSignal(8_000, signal), cache: "no-store" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ActionTargetsApiError("无法连接目标保存服务");
  }
  if (!response.ok) throw new ActionTargetsApiError(`目标读取失败（${response.status}）`, response.status);
  return parseSnapshot(await readJson(response));
}

export async function putActionTargets(
  targets: EditableActionTarget[],
  expectedHash: string,
  startCampaign = false,
): Promise<ActionTargetsSnapshot> {
  let response: Response;
  try {
    response = await fetch("/api/action-targets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targets, expectedHash, startCampaign }),
    });
  } catch {
    throw new ActionTargetsApiError("无法连接目标保存服务，当前改动尚未保存");
  }
  const raw = await readJson(response);
  if (response.status === 409) {
    const value = raw as Record<string, unknown>;
    throw new ActionTargetsConflictError(parseSnapshot(value.current));
  }
  if (!response.ok) {
    const message = raw && typeof raw === "object" ? (raw as Record<string, unknown>).message : null;
    throw new ActionTargetsApiError(typeof message === "string" ? message : `目标保存失败（${response.status}）`, response.status);
  }
  return parseSnapshot(raw);
}
