import { timeoutSignal } from "@/data/timeoutSignal";

export type DailyReviewConfirmation = "待人工确认" | "已确认";

export interface DailyReviewSnapshot {
  id: string;
  date: string;
  todayCompleted: string;
  facts: string;
  effectiveActions: string;
  problems: string;
  judgment: string;
  tomorrowAction: string;
  confirmation: DailyReviewConfirmation;
  confirmedAt: string | null;
  hash: string;
  updatedAt: string;
  source: string;
}

export interface DailyReviewsListSnapshot {
  items: DailyReviewSnapshot[];
  generatedAt: string;
}

export type CreateDailyReviewInput = Pick<DailyReviewSnapshot,
  "date" | "todayCompleted" | "facts" | "effectiveActions" | "problems" | "judgment" | "tomorrowAction"
>;

export type UpdateDailyReviewPatch = Partial<Pick<DailyReviewSnapshot,
  "todayCompleted" | "facts" | "effectiveActions" | "problems" | "judgment" | "tomorrowAction" | "confirmation"
>>;

export class DailyReviewsApiError extends Error {
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "DailyReviewsApiError";
    this.status = status;
  }
}

export class DailyReviewsConflictError extends DailyReviewsApiError {
  snapshot: DailyReviewSnapshot;
  constructor(snapshot: DailyReviewSnapshot) {
    super("Obsidian 中的每日复盘已被外部修改", 409);
    this.name = "DailyReviewsConflictError";
    this.snapshot = snapshot;
  }
}

const CREATE_WRITE_TIMEOUT_MS = 30_000;

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isSafeSource(value: string): boolean {
  return value.length > 0 && !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes("..");
}

function parseSnapshot(raw: unknown): DailyReviewSnapshot {
  if (!raw || typeof raw !== "object") throw new DailyReviewsApiError("每日复盘服务返回了无法识别的数据");
  const value = raw as Record<string, unknown>;
  if (
    typeof value.id !== "string"
    || typeof value.date !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)
    || typeof value.todayCompleted !== "string"
    || typeof value.facts !== "string"
    || typeof value.effectiveActions !== "string"
    || typeof value.problems !== "string"
    || typeof value.judgment !== "string"
    || typeof value.tomorrowAction !== "string"
    || !["待人工确认", "已确认"].includes(String(value.confirmation))
    || !isNullableString(value.confirmedAt)
    || typeof value.hash !== "string"
    || !/^[a-f0-9]{64}$/.test(value.hash)
    || typeof value.updatedAt !== "string"
    || typeof value.source !== "string"
    || !isSafeSource(value.source)
  ) throw new DailyReviewsApiError("每日复盘服务返回的数据格式不正确");
  return value as unknown as DailyReviewSnapshot;
}

async function readJson(response: Response): Promise<unknown> {
  try { return await response.json(); }
  catch { throw new DailyReviewsApiError("每日复盘服务返回了无法读取的响应", response.status); }
}

function messageFrom(raw: unknown, fallback: string): string {
  if (!raw || typeof raw !== "object") return fallback;
  const message = (raw as Record<string, unknown>).message;
  return typeof message === "string" ? message : fallback;
}

export async function getDailyReviews(signal?: AbortSignal): Promise<DailyReviewsListSnapshot> {
  let response: Response;
  try {
    response = await fetch("/api/daily-reviews", {
      signal: timeoutSignal(8_000, signal),
      cache: "no-store",
    });
  }
  catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new DailyReviewsApiError("无法连接每日复盘保存服务");
  }
  const raw = await readJson(response);
  if (!response.ok) throw new DailyReviewsApiError(messageFrom(raw, `每日复盘读取失败（${response.status}）`), response.status);
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as Record<string, unknown>).items) || typeof (raw as Record<string, unknown>).generatedAt !== "string") {
    throw new DailyReviewsApiError("每日复盘服务返回的列表格式不正确");
  }
  return {
    items: ((raw as Record<string, unknown>).items as unknown[]).map(parseSnapshot),
    generatedAt: (raw as Record<string, unknown>).generatedAt as string,
  };
}

export async function createDailyReview(
  input: CreateDailyReviewInput,
  clientRequestId: string,
): Promise<DailyReviewSnapshot> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientRequestId)) {
    throw new DailyReviewsApiError("新建每日复盘请求编号无效");
  }
  let response: Response;
  try {
    response = await fetch("/api/daily-reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Idempotency-Key": clientRequestId },
      body: JSON.stringify(input),
      signal: timeoutSignal(CREATE_WRITE_TIMEOUT_MS),
    });
  } catch { throw new DailyReviewsApiError("无法确认保存结果，请保持当前窗口并重试确认"); }
  const raw = await readJson(response);
  if (response.status === 409) {
    const current = raw && typeof raw === "object" ? (raw as Record<string, unknown>).current : null;
    if (current) throw new DailyReviewsConflictError(parseSnapshot(current));
    throw new DailyReviewsApiError("同一次新建请求的内容已发生变化，请核对后重试", 409);
  }
  if (!response.ok) throw new DailyReviewsApiError(messageFrom(raw, `每日复盘新建失败（${response.status}）`), response.status);
  return parseSnapshot(raw);
}

export async function updateDailyReview(id: string, patch: UpdateDailyReviewPatch, expectedHash: string): Promise<DailyReviewSnapshot> {
  let response: Response;
  try {
    response = await fetch("/api/daily-reviews", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, patch, expectedHash }),
    });
  } catch { throw new DailyReviewsApiError("无法连接每日复盘保存服务，当前修改尚未保存"); }
  const raw = await readJson(response);
  if (response.status === 409) {
    const current = raw && typeof raw === "object" ? (raw as Record<string, unknown>).current : null;
    if (current) throw new DailyReviewsConflictError(parseSnapshot(current));
    throw new DailyReviewsApiError("每日复盘已被外部修改，请刷新后重试", 409);
  }
  if (!response.ok) throw new DailyReviewsApiError(messageFrom(raw, `每日复盘保存失败（${response.status}）`), response.status);
  return parseSnapshot(raw);
}
