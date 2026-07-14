import { timeoutSignal } from "@/data/timeoutSignal";

export interface EditablePlatformFollower {
  id: string;
  currentFollowers: number;
}

export interface PlatformFollowersSnapshot {
  accounts: Array<EditablePlatformFollower & { asOf: string }>;
  hash: string;
  updatedAt: string;
}

export class PlatformFollowersApiError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
  }
}

export class PlatformFollowersConflictError extends PlatformFollowersApiError {
  constructor(readonly snapshot: PlatformFollowersSnapshot) {
    super("Obsidian 中的平台粉丝数已更新", 409);
  }
}

const platformAccountIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

function hasValidAccountRows(rows: unknown[], requireAsOf: boolean): boolean {
  if (rows.length < 1 || rows.length > 20) return false;
  const ids: string[] = [];
  for (const item of rows) {
    if (!item || typeof item !== "object") return false;
    const row = item as Record<string, unknown>;
    if (
      typeof row.id !== "string"
      || !platformAccountIdPattern.test(row.id)
      || typeof row.currentFollowers !== "number"
      || !Number.isInteger(row.currentFollowers)
      || row.currentFollowers < 0
      || (requireAsOf && typeof row.asOf !== "string")
    ) {
      return false;
    }
    ids.push(row.id);
  }
  return new Set(ids).size === ids.length;
}

function parseSnapshot(raw: unknown): PlatformFollowersSnapshot {
  if (!raw || typeof raw !== "object") throw new PlatformFollowersApiError("平台粉丝服务返回了无法识别的数据");
  const value = raw as Record<string, unknown>;
  const accountRows = Array.isArray(value.accounts) ? value.accounts : [];
  if (!Array.isArray(value.accounts) || !hasValidAccountRows(accountRows, true)
    || typeof value.hash !== "string" || typeof value.updatedAt !== "string") {
    throw new PlatformFollowersApiError("平台粉丝服务返回的数据格式不正确");
  }
  return value as unknown as PlatformFollowersSnapshot;
}

async function readJson(response: Response) {
  try { return await response.json() as unknown; }
  catch { throw new PlatformFollowersApiError("平台粉丝服务返回了无法读取的响应", response.status); }
}

export async function getPlatformFollowers(signal?: AbortSignal): Promise<PlatformFollowersSnapshot> {
  let response: Response;
  try { response = await fetch("/api/platform-followers", { signal: timeoutSignal(8_000, signal), cache: "no-store" }); }
  catch { throw new PlatformFollowersApiError("无法连接平台粉丝保存服务"); }
  if (!response.ok) throw new PlatformFollowersApiError(`平台粉丝读取失败（${response.status}）`, response.status);
  return parseSnapshot(await readJson(response));
}

export async function putPlatformFollowers(accounts: EditablePlatformFollower[], expectedHash: string): Promise<PlatformFollowersSnapshot> {
  if (!Array.isArray(accounts) || !hasValidAccountRows(accounts, false)) {
    throw new PlatformFollowersApiError("平台粉丝数据格式不正确");
  }
  let response: Response;
  try {
    response = await fetch("/api/platform-followers", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accounts, expectedHash }),
    });
  } catch {
    throw new PlatformFollowersApiError("无法连接平台粉丝保存服务，当前改动尚未保存");
  }
  const raw = await readJson(response);
  if (response.status === 409) {
    const value = raw as Record<string, unknown>;
    throw new PlatformFollowersConflictError(parseSnapshot(value.current));
  }
  if (!response.ok) {
    const message = raw && typeof raw === "object" ? (raw as Record<string, unknown>).message : null;
    throw new PlatformFollowersApiError(typeof message === "string" ? message : `平台粉丝保存失败（${response.status}）`, response.status);
  }
  return parseSnapshot(raw);
}
