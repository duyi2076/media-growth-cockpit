import { timeoutSignal } from "@/data/timeoutSignal";

export type ReviewAssetKind = "content-review" | "account-breakdown";
export type ReviewAssetConfirmation = "待人工确认" | "已确认";

export interface ReviewAssetSnapshot {
  id: string;
  kind: ReviewAssetKind;
  title: string;
  sourceUrl: string | null;
  platform: string | null;
  relatedContentId: string | null;
  summary: string;
  findings: string;
  nextAction: string;
  confirmation: ReviewAssetConfirmation;
  confirmedAt: string | null;
  hash: string;
  updatedAt: string;
  source: string;
}

export interface ReviewAssetsListSnapshot {
  items: ReviewAssetSnapshot[];
  generatedAt: string;
}

export type CreateReviewAssetInput = Pick<
  ReviewAssetSnapshot,
  "kind" | "title" | "sourceUrl" | "platform" | "relatedContentId" | "summary" | "findings" | "nextAction"
>;

export type UpdateReviewAssetPatch = Partial<Pick<
  ReviewAssetSnapshot,
  "title" | "sourceUrl" | "platform" | "relatedContentId" | "summary" | "findings" | "nextAction" | "confirmation"
>>;

export class ReviewAssetsApiError extends Error {
  status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ReviewAssetsApiError";
    this.status = status;
  }
}

export class ReviewAssetsConflictError extends ReviewAssetsApiError {
  snapshot: ReviewAssetSnapshot;

  constructor(snapshot: ReviewAssetSnapshot) {
    super("Obsidian 中的复盘资产已被外部修改", 409);
    this.name = "ReviewAssetsConflictError";
    this.snapshot = snapshot;
  }
}

const kinds = new Set<ReviewAssetKind>(["content-review", "account-breakdown"]);
const confirmations = new Set<ReviewAssetConfirmation>(["待人工确认", "已确认"]);
const CREATE_WRITE_TIMEOUT_MS = 30_000;

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isSafeRelativeSource(value: string): boolean {
  return value.length > 0
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.split("/").includes("..");
}

function parseSnapshot(raw: unknown): ReviewAssetSnapshot {
  if (!raw || typeof raw !== "object") {
    throw new ReviewAssetsApiError("复盘服务返回了无法识别的数据");
  }
  const value = raw as Record<string, unknown>;
  if (
    typeof value.id !== "string"
    || typeof value.kind !== "string"
    || !kinds.has(value.kind as ReviewAssetKind)
    || typeof value.title !== "string"
    || !isNullableString(value.sourceUrl)
    || (typeof value.sourceUrl === "string" && !isHttpsUrl(value.sourceUrl))
    || !isNullableString(value.platform)
    || !isNullableString(value.relatedContentId)
    || typeof value.summary !== "string"
    || typeof value.findings !== "string"
    || typeof value.nextAction !== "string"
    || typeof value.confirmation !== "string"
    || !confirmations.has(value.confirmation as ReviewAssetConfirmation)
    || !isNullableString(value.confirmedAt)
    || typeof value.hash !== "string"
    || !/^[a-f0-9]{64}$/.test(value.hash)
    || typeof value.updatedAt !== "string"
    || typeof value.source !== "string"
    || !isSafeRelativeSource(value.source)
  ) {
    throw new ReviewAssetsApiError("复盘服务返回的数据格式不正确");
  }
  return value as unknown as ReviewAssetSnapshot;
}

function parseList(raw: unknown): ReviewAssetsListSnapshot {
  if (!raw || typeof raw !== "object") {
    throw new ReviewAssetsApiError("复盘服务返回了无法识别的列表");
  }
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.items) || typeof value.generatedAt !== "string") {
    throw new ReviewAssetsApiError("复盘服务返回的列表格式不正确");
  }
  return { items: value.items.map(parseSnapshot), generatedAt: value.generatedAt };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ReviewAssetsApiError("复盘服务返回了无法读取的响应", response.status);
  }
}

function messageFrom(raw: unknown, fallback: string): string {
  if (!raw || typeof raw !== "object") return fallback;
  const message = (raw as Record<string, unknown>).message;
  return typeof message === "string" ? message : fallback;
}

export async function getReviewAssets(signal?: AbortSignal): Promise<ReviewAssetsListSnapshot> {
  let response: Response;
  try {
    response = await fetch("/api/review-assets", {
      signal: timeoutSignal(8_000, signal),
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ReviewAssetsApiError("无法连接复盘保存服务");
  }
  const raw = await readJson(response);
  if (!response.ok) {
    throw new ReviewAssetsApiError(messageFrom(raw, `复盘读取失败（${response.status}）`), response.status);
  }
  return parseList(raw);
}

export async function createReviewAsset(
  input: CreateReviewAssetInput,
  clientRequestId: string,
): Promise<ReviewAssetSnapshot> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientRequestId)) {
    throw new ReviewAssetsApiError("新建复盘请求编号无效");
  }
  let response: Response;
  try {
    response = await fetch("/api/review-assets", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Idempotency-Key": clientRequestId },
      body: JSON.stringify(input),
      signal: timeoutSignal(CREATE_WRITE_TIMEOUT_MS),
    });
  } catch {
    throw new ReviewAssetsApiError("无法确认保存结果，请保持当前窗口并重试确认");
  }
  const raw = await readJson(response);
  if (response.status === 409) {
    const current = raw && typeof raw === "object" ? (raw as Record<string, unknown>).current : null;
    if (current) throw new ReviewAssetsConflictError(parseSnapshot(current));
    throw new ReviewAssetsApiError("同一次新建请求的内容已发生变化，请核对后重试", 409);
  }
  if (!response.ok) {
    throw new ReviewAssetsApiError(messageFrom(raw, `复盘新建失败（${response.status}）`), response.status);
  }
  return parseSnapshot(raw);
}

export async function updateReviewAsset(
  id: string,
  patch: UpdateReviewAssetPatch,
  expectedHash: string,
): Promise<ReviewAssetSnapshot> {
  let response: Response;
  try {
    response = await fetch("/api/review-assets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, patch, expectedHash }),
    });
  } catch {
    throw new ReviewAssetsApiError("无法连接复盘保存服务，当前修改尚未保存");
  }
  const raw = await readJson(response);
  if (response.status === 409) {
    const current = raw && typeof raw === "object" ? (raw as Record<string, unknown>).current : null;
    if (current) throw new ReviewAssetsConflictError(parseSnapshot(current));
    throw new ReviewAssetsApiError("复盘资产已被外部修改，请刷新后重试", 409);
  }
  if (!response.ok) {
    throw new ReviewAssetsApiError(messageFrom(raw, `复盘保存失败（${response.status}）`), response.status);
  }
  return parseSnapshot(raw);
}
