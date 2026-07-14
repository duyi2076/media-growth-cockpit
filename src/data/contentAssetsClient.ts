import type { ContentFormat, ContentStatus, Priority } from "@/types";
import { timeoutSignal } from "@/data/timeoutSignal";

export interface ContentAssetSnapshot {
  id: string;
  title: string;
  status: ContentStatus;
  format: ContentFormat;
  channels: string[];
  priority: Priority | null;
  dueAt: string | null;
  nextAction: string;
  completedAt: string | null;
  publicationRecords: ContentPublicationRecord[];
  hash: string;
  updatedAt: string;
}

export interface ContentPublicationRecord {
  id: string;
  platform: string;
  publishedAt: string | null;
  url: string | null;
  evidenceRef: string | null;
  verification: "已核验" | "待核验";
}

export interface RegisterContentPublicationInput {
  platform: string;
  publishedAt: string;
  url?: string;
  evidenceRef?: string;
  confirmed: true;
}

export interface ContentAssetsListSnapshot {
  items: ContentAssetSnapshot[];
  generatedAt: string;
}

export interface CreateContentAssetInput {
  title: string;
  summary: string;
  status: ContentStatus;
  format: ContentFormat;
  channels: string[];
  priority: Priority | null;
  dueAt: string | null;
  nextAction: string;
}

export type UpdateContentAssetPatch = Partial<Pick<
  ContentAssetSnapshot,
  "status" | "format" | "channels" | "priority" | "dueAt" | "nextAction"
>>;

export class ContentAssetsApiError extends Error {
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ContentAssetsApiError";
    this.status = status;
  }
}

export class ContentAssetsConflictError extends ContentAssetsApiError {
  snapshot: ContentAssetSnapshot;
  constructor(snapshot: ContentAssetSnapshot) {
    super("Obsidian 中的内容资产已被外部修改", 409);
    this.name = "ContentAssetsConflictError";
    this.snapshot = snapshot;
  }
}

const statuses = new Set<ContentStatus>([
  "候选选题", "已立项", "待发布", "已发布", "待复盘", "已归档",
]);
const formats = new Set<ContentFormat>(["文章", "短视频口播", "图文卡片", "直播稿", "系列"]);
const priorities = new Set<Priority>(["P0", "P1", "P2", "P3"]);
const CREATE_WRITE_TIMEOUT_MS = 30_000;

function parseSnapshot(raw: unknown): ContentAssetSnapshot {
  if (!raw || typeof raw !== "object") throw new ContentAssetsApiError("内容服务返回了无法识别的数据");
  const value = raw as Record<string, unknown>;
  if (
    typeof value.id !== "string"
    || typeof value.title !== "string"
    || typeof value.status !== "string"
    || !statuses.has(value.status as ContentStatus)
    || typeof value.format !== "string"
    || !formats.has(value.format as ContentFormat)
    || !Array.isArray(value.channels)
    || !value.channels.every((channel) => typeof channel === "string")
    || !(value.priority === null || (typeof value.priority === "string" && priorities.has(value.priority as Priority)))
    || !(value.dueAt === null || typeof value.dueAt === "string")
    || typeof value.nextAction !== "string"
    || !(value.completedAt === null || (typeof value.completedAt === "string" && !Number.isNaN(Date.parse(value.completedAt))))
    || !Array.isArray(value.publicationRecords)
    || typeof value.hash !== "string"
    || !/^[a-f0-9]{64}$/.test(value.hash)
    || typeof value.updatedAt !== "string"
  ) {
    throw new ContentAssetsApiError("内容服务返回的数据格式不正确");
  }
  return {
    ...value,
    publicationRecords: value.publicationRecords.map(parsePublicationRecord),
  } as unknown as ContentAssetSnapshot;
}

function parsePublicationRecord(raw: unknown): ContentPublicationRecord {
  if (!raw || typeof raw !== "object") throw new ContentAssetsApiError("发布记录格式不正确");
  const value = raw as Record<string, unknown>;
  if (
    typeof value.id !== "string"
    || typeof value.platform !== "string"
    || !(value.publishedAt === null || (typeof value.publishedAt === "string" && !Number.isNaN(Date.parse(value.publishedAt))))
    || !(value.url === null || (typeof value.url === "string" && value.url.startsWith("https://")))
    || !(value.evidenceRef === null || typeof value.evidenceRef === "string")
    || !["已核验", "待核验"].includes(String(value.verification))
  ) {
    throw new ContentAssetsApiError("发布记录格式不正确");
  }
  return value as unknown as ContentPublicationRecord;
}

function parseList(raw: unknown): ContentAssetsListSnapshot {
  if (!raw || typeof raw !== "object") throw new ContentAssetsApiError("内容服务返回了无法识别的列表");
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.items) || typeof value.generatedAt !== "string") {
    throw new ContentAssetsApiError("内容服务返回的列表格式不正确");
  }
  return { items: value.items.map(parseSnapshot), generatedAt: value.generatedAt };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ContentAssetsApiError("内容服务返回了无法读取的响应", response.status);
  }
}

function messageFrom(raw: unknown, fallback: string): string {
  if (!raw || typeof raw !== "object") return fallback;
  const message = (raw as Record<string, unknown>).message;
  return typeof message === "string" ? message : fallback;
}

export async function getContentAssets(signal?: AbortSignal): Promise<ContentAssetsListSnapshot> {
  let response: Response;
  try {
    response = await fetch("/api/content-assets", { signal: timeoutSignal(8_000, signal), cache: "no-store" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ContentAssetsApiError("无法连接内容保存服务");
  }
  const raw = await readJson(response);
  if (!response.ok) throw new ContentAssetsApiError(messageFrom(raw, `内容读取失败（${response.status}）`), response.status);
  return parseList(raw);
}

export async function createContentAsset(
  input: CreateContentAssetInput,
  clientRequestId: string,
): Promise<ContentAssetSnapshot> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientRequestId)) {
    throw new ContentAssetsApiError("新建内容请求编号无效");
  }
  let response: Response;
  try {
    response = await fetch("/api/content-assets", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Idempotency-Key": clientRequestId },
      body: JSON.stringify(input),
      signal: timeoutSignal(CREATE_WRITE_TIMEOUT_MS),
    });
  } catch {
    throw new ContentAssetsApiError("无法确认保存结果，请保持当前窗口并重试确认");
  }
  const raw = await readJson(response);
  if (response.status === 409) {
    const current = raw && typeof raw === "object" ? (raw as Record<string, unknown>).current : null;
    if (current) throw new ContentAssetsConflictError(parseSnapshot(current));
    throw new ContentAssetsApiError("同一次新建请求的内容已发生变化，请核对后重试", 409);
  }
  if (!response.ok) throw new ContentAssetsApiError(messageFrom(raw, `内容新增失败（${response.status}）`), response.status);
  return parseSnapshot(raw);
}

export async function updateContentAsset(
  id: string,
  patch: UpdateContentAssetPatch,
  expectedHash: string,
): Promise<ContentAssetSnapshot> {
  let response: Response;
  try {
    response = await fetch("/api/content-assets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, patch, expectedHash }),
    });
  } catch {
    throw new ContentAssetsApiError("无法连接内容保存服务，当前改动尚未保存");
  }
  const raw = await readJson(response);
  if (response.status === 409) {
    const current = raw && typeof raw === "object" ? (raw as Record<string, unknown>).current : null;
    if (current) throw new ContentAssetsConflictError(parseSnapshot(current));
    throw new ContentAssetsApiError("内容已被外部修改，请刷新后重试", 409);
  }
  if (!response.ok) throw new ContentAssetsApiError(messageFrom(raw, `内容保存失败（${response.status}）`), response.status);
  return parseSnapshot(raw);
}

export async function markContentAssetComplete(
  id: string,
  expectedHash: string,
): Promise<ContentAssetSnapshot> {
  return postContentAction("/api/content-assets/complete", { id, expectedHash }, "制作完成状态尚未保存");
}

export async function registerContentPublication(
  id: string,
  expectedHash: string,
  input: RegisterContentPublicationInput,
): Promise<ContentAssetSnapshot> {
  return postContentAction(
    "/api/content-assets/publications",
    { id, expectedHash, ...input },
    "发布记录尚未保存",
  );
}

async function postContentAction(
  endpoint: string,
  body: Record<string, unknown>,
  disconnectedMessage: string,
): Promise<ContentAssetSnapshot> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ContentAssetsApiError(`无法连接内容保存服务，${disconnectedMessage}`);
  }
  const raw = await readJson(response);
  if (response.status === 409) {
    const current = raw && typeof raw === "object" ? (raw as Record<string, unknown>).current : null;
    if (current) throw new ContentAssetsConflictError(parseSnapshot(current));
    throw new ContentAssetsApiError("内容已被外部修改，请刷新后重试", 409);
  }
  if (!response.ok) {
    throw new ContentAssetsApiError(messageFrom(raw, `内容保存失败（${response.status}）`), response.status);
  }
  return parseSnapshot(raw);
}
