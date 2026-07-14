import { timeoutSignal } from "@/data/timeoutSignal";

export interface CockpitSettings {
  productName: string;
  ownerName: string;
  creatorPositioning: string;
  campaignName: string;
  growthTarget: number;
  startDate: string | null;
  deadline: string | null;
  projectRelativeDir: string;
  baselineDate: string;
  baselineRelativePath: string;
}
export interface CockpitSettingsSnapshot {
  settings: CockpitSettings;
  initialized: boolean;
  hash: string | null;
  updatedAt: string | null;
}

export class CockpitSettingsApiError extends Error {
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "CockpitSettingsApiError";
    this.status = status;
  }
}

export class CockpitSettingsConflictError extends CockpitSettingsApiError {
  snapshot: CockpitSettingsSnapshot;
  constructor(snapshot: CockpitSettingsSnapshot) {
    super("Obsidian 中的驾驶舱设置已被外部修改", 409);
    this.name = "CockpitSettingsConflictError";
    this.snapshot = snapshot;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HASH_RE = /^[a-f0-9]{64}$/;

function isNullableDate(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && DATE_RE.test(value));
}

function parseSnapshot(raw: unknown): CockpitSettingsSnapshot {
  if (!raw || typeof raw !== "object") throw new CockpitSettingsApiError("设置服务返回了无法识别的数据");
  const value = raw as Record<string, unknown>;
  const settings = value.settings as Record<string, unknown> | null;
  if (
    !settings
    || typeof settings.productName !== "string"
    || typeof settings.ownerName !== "string"
    || typeof settings.creatorPositioning !== "string"
    || typeof settings.campaignName !== "string"
    || typeof settings.growthTarget !== "number"
    || !Number.isInteger(settings.growthTarget)
    || settings.growthTarget < 1
    || !isNullableDate(settings.startDate)
    || !isNullableDate(settings.deadline)
    || typeof settings.projectRelativeDir !== "string"
    || typeof settings.baselineDate !== "string"
    || !DATE_RE.test(settings.baselineDate)
    || typeof settings.baselineRelativePath !== "string"
    || typeof value.initialized !== "boolean"
    || !(value.hash === null || (typeof value.hash === "string" && HASH_RE.test(value.hash)))
    || !(value.updatedAt === null || typeof value.updatedAt === "string")
  ) {
    throw new CockpitSettingsApiError("设置服务返回的数据格式不正确");
  }
  return value as unknown as CockpitSettingsSnapshot;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new CockpitSettingsApiError("设置服务返回了无法读取的响应", response.status);
  }
}

export async function getCockpitSettings(signal?: AbortSignal): Promise<CockpitSettingsSnapshot> {
  let response: Response;
  try {
    response = await fetch("/api/cockpit-settings", { signal: timeoutSignal(8_000, signal), cache: "no-store" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new CockpitSettingsApiError("无法连接驾驶舱设置服务");
  }
  if (!response.ok) throw new CockpitSettingsApiError(`设置读取失败（${response.status}）`, response.status);
  return parseSnapshot(await readJson(response));
}

export async function putCockpitSettings(
  settings: CockpitSettings,
  expectedHash: string | null,
): Promise<CockpitSettingsSnapshot> {
  let response: Response;
  try {
    response = await fetch("/api/cockpit-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings, expectedHash }),
    });
  } catch {
    throw new CockpitSettingsApiError("无法连接驾驶舱设置服务，当前改动尚未保存");
  }
  const raw = await readJson(response);
  if (response.status === 409) {
    const value = raw as Record<string, unknown>;
    throw new CockpitSettingsConflictError(parseSnapshot(value.current));
  }
  if (!response.ok) {
    const message = raw && typeof raw === "object" ? (raw as Record<string, unknown>).message : null;
    throw new CockpitSettingsApiError(typeof message === "string" ? message : `设置保存失败（${response.status}）`, response.status);
  }
  return parseSnapshot(raw);
}
