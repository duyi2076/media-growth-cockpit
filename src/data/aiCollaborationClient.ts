import { z } from "zod";
import { timeoutSignal } from "@/data/timeoutSignal";

export const aiAgentIdSchema = z.enum(["codex", "claude", "kimi", "gemini", "antigravity", "grok"]);
export type AiAgentId = z.infer<typeof aiAgentIdSchema>;

export const aiAgentStatusSchema = z.enum([
  "ready",
  "missing",
  "adapter_required",
  "incompatible",
  "timeout",
  "error",
]);
export type AiAgentStatus = z.infer<typeof aiAgentStatusSchema>;

export const aiAgentCatalogItemSchema = z.object({
  id: aiAgentIdSchema,
  displayName: z.string().min(1),
  installed: z.boolean(),
  version: z.string().nullable(),
  latestStable: z.string().min(1),
  testedVersion: z.string().min(1),
  versionStatus: z.enum(["current", "outdated", "newer", "unknown"]),
  acpMode: z.enum(["native", "adapter", "conversation_cli"]),
  status: aiAgentStatusSchema,
  authStatus: z.enum(["unknown", "ready", "login_required"]),
  officialSource: z.string().url(),
  actions: z.object({
    canInstall: z.boolean(),
    canUpdate: z.boolean(),
    canLogin: z.boolean(),
  }),
  adapter: z.object({
    packageName: z.string().min(1),
    installed: z.boolean(),
    version: z.string().nullable().optional(),
    automaticInstall: z.literal(false),
  }).optional(),
});
export type AiAgentCatalogItem = z.infer<typeof aiAgentCatalogItemSchema>;

const aiAgentsResponseSchema = z.object({
  agents: z.array(aiAgentCatalogItemSchema),
  policy: z.object({
    automaticInstall: z.literal(false),
    automaticUpgrade: z.literal(false),
    credentialAccess: z.literal(false),
    userConfirmedActions: z.literal(true),
    supportedPlatform: z.enum(["macos", "unsupported"]),
  }),
});
export type AiAgentsResponse = z.infer<typeof aiAgentsResponseSchema>;

export const aiEnvironmentActionSchema = z.enum(["install", "update", "login"]);
export type AiEnvironmentAction = z.infer<typeof aiEnvironmentActionSchema>;

export const aiEnvironmentJobSchema = z.object({
  id: z.string().min(1),
  provider: z.enum(["codex", "claude", "kimi", "antigravity", "grok"]),
  action: aiEnvironmentActionSchema,
  status: z.enum(["queued", "running", "completed", "failed", "terminal_opened"]),
  message: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type AiEnvironmentJob = z.infer<typeof aiEnvironmentJobSchema>;

export const aiContextKindSchema = z.enum([
  "topic",
  "content",
  "content-review",
  "account-breakdown",
  "daily-review",
]);
export type AiContextKind = z.infer<typeof aiContextKindSchema>;

export const AI_TASK_TEMPLATE_IDS = [
  "analyze-topic",
  "break-down-content",
  "draft-article",
  "draft-video",
  "review-content",
  "analyze-account",
  "review-day",
  "plan-tomorrow",
] as const;
export const aiTaskTemplateIdSchema = z.enum(AI_TASK_TEMPLATE_IDS);
export type AiTaskTemplateId = z.infer<typeof aiTaskTemplateIdSchema>;

export const aiPermissionModeSchema = z.enum(["readonly", "ask"]);
export type AiPermissionMode = z.infer<typeof aiPermissionModeSchema>;

export const aiRunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_permission",
  "completed",
  "failed",
  "cancelled",
]);
export type AiRunStatus = z.infer<typeof aiRunStatusSchema>;

export const aiRunEventTypeSchema = z.enum([
  "status",
  "message",
  "thought",
  "plan",
  "tool_call",
  "tool_update",
  "diff",
  "permission",
  "error",
  "completed",
]);
export type AiRunEventType = z.infer<typeof aiRunEventTypeSchema>;

export const aiRunEventSchema = z.object({
  seq: z.number().int().min(0),
  id: z.string().min(1),
  type: aiRunEventTypeSchema,
  createdAt: z.string().min(1),
  text: z.string().optional(),
  title: z.string().optional(),
  status: z.string().optional(),
  toolCallId: z.string().optional(),
  permissionId: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
export type AiRunEvent = z.infer<typeof aiRunEventSchema>;

const aiRunContextSchema = z.object({
  type: aiContextKindSchema,
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().optional(),
});
export type AiRunContext = z.infer<typeof aiRunContextSchema>;

export interface AiRunContextReference {
  type: AiContextKind;
  id: string;
}

export const aiTaskLinkTypeSchema = z.enum([
  "topic",
  "content",
  "content-review",
  "account-breakdown",
  "daily-review",
  "task",
]);
export type AiTaskLinkType = z.infer<typeof aiTaskLinkTypeSchema>;

export const aiSourceTaskSchema = z.object({
  id: z.string().min(1),
  date: z.string().min(1),
  title: z.string().min(1),
  linkType: aiTaskLinkTypeSchema,
  linkId: z.string().min(1),
});
export type AiSourceTask = z.infer<typeof aiSourceTaskSchema>;

export const aiDeliveryKindSchema = z.enum(["content_draft", "review_draft", "next_day_task"]);
export type AiDeliveryKind = z.infer<typeof aiDeliveryKindSchema>;

export const aiDeliverySchema = z.object({
  id: z.string().min(1),
  kind: aiDeliveryKindSchema,
  status: z.literal("completed"),
  sourceRunId: z.string().min(1),
  sourceTaskId: z.string().min(1),
  targetType: z.enum(["content", "review", "task"]),
  targetId: z.string().nullable(),
  targetRelativePath: z.string().min(1),
  targetTitle: z.string().min(1),
  createdAt: z.string().min(1),
});
export type AiDelivery = z.infer<typeof aiDeliverySchema>;

export const aiRunSchema = z.object({
  id: z.string().min(1),
  provider: aiAgentIdSchema,
  status: aiRunStatusSchema,
  templateId: aiTaskTemplateIdSchema,
  context: aiRunContextSchema.optional(),
  sourceTask: aiSourceTaskSchema.nullable().default(null),
  deliveries: z.array(aiDeliverySchema).default([]),
  permissionMode: aiPermissionModeSchema,
  runtime: z.object({
    providerVersion: z.string().nullable(),
    adapterPackage: z.string().nullable(),
    adapterVersion: z.string().nullable(),
    protocolVersion: z.number().int().positive().nullable(),
    versionStatus: z.enum(["current", "outdated", "newer", "unknown"]),
  }).optional(),
  instruction: z.string(),
  finalText: z.string().default(""),
  pendingPermission: z.object({
    id: z.string().min(1),
    toolCallId: z.string().min(1),
    title: z.string().min(1),
    kind: z.string().optional(),
    options: z.array(z.object({
      optionId: z.string().min(1),
      name: z.string().min(1),
      kind: z.enum(["allow_once", "reject_once"]),
    })),
    createdAt: z.string().min(1),
    expiresAt: z.string().min(1),
  }).nullable().default(null),
  importedAt: z.string().nullable().default(null),
  importedRelativePath: z.string().nullable().default(null),
  events: z.array(aiRunEventSchema).default([]),
  error: z.string().nullable().default(null),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type AiRun = z.infer<typeof aiRunSchema>;

const aiRunsResponseSchema = z.object({
  runs: z.array(aiRunSchema),
});
export type AiRunsResponse = z.infer<typeof aiRunsResponseSchema>;

export interface CreateAiRunInput {
  provider: AiAgentId;
  templateId: AiTaskTemplateId;
  context: AiRunContextReference;
  permissionMode: AiPermissionMode;
  instruction: string;
  sourceTaskId?: string;
}

export type CreateAiDeliveryInput =
  | {
    kind: "content_draft";
    contentFormat: "文章" | "短视频口播";
    title: string;
  }
  | {
    kind: "review_draft";
    reviewKind: "content-review" | "account-breakdown";
    title: string;
    summary?: string;
    nextAction: string;
  }
  | {
    kind: "next_day_task";
    tasks: string[];
  };

export interface CreateAiDeliveryResult {
  run: AiRun | null;
  delivery: AiDelivery;
}

export class AiCollaborationApiError extends Error {
  status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "AiCollaborationApiError";
    this.status = status;
  }
}

const CSRF_HEADER = { "X-Cockpit-CSRF": "1" } as const;

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new AiCollaborationApiError("AI 协作服务返回了无法读取的响应", response.status);
  }
}

function messageFrom(raw: unknown, fallback: string): string {
  if (!raw || typeof raw !== "object") return fallback;
  const message = (raw as Record<string, unknown>).message;
  return typeof message === "string" ? message : fallback;
}

function parseRunResponse(raw: unknown): AiRun {
  const value = raw && typeof raw === "object" && "run" in raw
    ? (raw as Record<string, unknown>).run
    : raw;
  const parsed = aiRunSchema.safeParse(value);
  if (!parsed.success) throw new AiCollaborationApiError("AI 运行服务返回的数据格式不正确");
  return parsed.data;
}

export async function getAiAgents(
  signal?: AbortSignal,
  options: { refresh?: boolean } = {},
): Promise<AiAgentsResponse> {
  let response: Response;
  try {
    response = await fetch(options.refresh ? "/api/ai-agents?refresh=1" : "/api/ai-agents", {
      signal: timeoutSignal(20_000, signal),
      cache: "no-store",
      ...(options.refresh ? { headers: CSRF_HEADER } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new AiCollaborationApiError("无法连接 AI 状态服务");
  }
  const raw = await readJson(response);
  if (!response.ok) throw new AiCollaborationApiError(messageFrom(raw, `AI 状态读取失败（${response.status}）`), response.status);
  const parsed = aiAgentsResponseSchema.safeParse(raw);
  if (!parsed.success) throw new AiCollaborationApiError("AI 状态服务返回的数据格式不正确");
  return parsed.data;
}

function parseEnvironmentJob(raw: unknown): AiEnvironmentJob {
  const candidate = raw && typeof raw === "object" && "job" in raw
    ? (raw as Record<string, unknown>).job
    : raw;
  const parsed = aiEnvironmentJobSchema.safeParse(candidate);
  if (!parsed.success) throw new AiCollaborationApiError("本机 AI 环境服务返回的数据格式不正确");
  return parsed.data;
}

export async function startAiEnvironmentAction(provider: AiAgentId, action: AiEnvironmentAction): Promise<AiEnvironmentJob> {
  let response: Response;
  try {
    response = await fetch("/api/ai-environment/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...CSRF_HEADER },
      body: JSON.stringify({ provider, action }),
    });
  } catch {
    throw new AiCollaborationApiError("无法连接本机 AI 环境服务");
  }
  const raw = await readJson(response);
  if (!response.ok) throw new AiCollaborationApiError(messageFrom(raw, `环境操作启动失败（${response.status}）`), response.status);
  return parseEnvironmentJob(raw);
}

export async function getAiEnvironmentJob(jobId: string, signal?: AbortSignal): Promise<AiEnvironmentJob> {
  let response: Response;
  try {
    response = await fetch(`/api/ai-environment/actions/${encodeURIComponent(jobId)}`, {
      signal: timeoutSignal(8_000, signal),
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new AiCollaborationApiError("无法读取本机 AI 环境操作状态");
  }
  const raw = await readJson(response);
  if (!response.ok) throw new AiCollaborationApiError(messageFrom(raw, `环境状态读取失败（${response.status}）`), response.status);
  return parseEnvironmentJob(raw);
}

export async function getAiRuns(signal?: AbortSignal): Promise<AiRunsResponse> {
  let response: Response;
  try {
    response = await fetch("/api/ai-runs", { signal: timeoutSignal(8_000, signal), cache: "no-store" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new AiCollaborationApiError("无法连接 AI 运行服务");
  }
  const raw = await readJson(response);
  if (!response.ok) throw new AiCollaborationApiError(messageFrom(raw, `运行记录读取失败（${response.status}）`), response.status);
  const parsed = aiRunsResponseSchema.safeParse(raw);
  if (!parsed.success) throw new AiCollaborationApiError("AI 运行服务返回的列表格式不正确");
  return parsed.data;
}

export async function getAiRun(id: string, signal?: AbortSignal): Promise<AiRun> {
  let response: Response;
  try {
    response = await fetch(`/api/ai-runs/${encodeURIComponent(id)}`, {
      signal: timeoutSignal(8_000, signal),
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new AiCollaborationApiError("无法连接 AI 运行服务");
  }
  const raw = await readJson(response);
  if (!response.ok) throw new AiCollaborationApiError(messageFrom(raw, `运行状态读取失败（${response.status}）`), response.status);
  return parseRunResponse(raw);
}

export async function createAiRun(input: CreateAiRunInput): Promise<AiRun> {
  let response: Response;
  try {
    response = await fetch("/api/ai-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...CSRF_HEADER },
      body: JSON.stringify(input),
    });
  } catch {
    throw new AiCollaborationApiError("无法连接 AI 运行服务，任务尚未开始");
  }
  const raw = await readJson(response);
  if (!response.ok) throw new AiCollaborationApiError(messageFrom(raw, `任务启动失败（${response.status}）`), response.status);
  return parseRunResponse(raw);
}

export async function cancelAiRun(id: string): Promise<AiRun> {
  let response: Response;
  try {
    response = await fetch(`/api/ai-runs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      headers: CSRF_HEADER,
    });
  } catch {
    throw new AiCollaborationApiError("无法连接 AI 运行服务，任务取消状态尚未确认");
  }
  const raw = await readJson(response);
  if (!response.ok) throw new AiCollaborationApiError(messageFrom(raw, `任务取消失败（${response.status}）`), response.status);
  return parseRunResponse(raw);
}

export async function respondAiPermission(
  runId: string,
  permissionId: string,
  optionId: string,
): Promise<AiRun> {
  let response: Response;
  try {
    response = await fetch(
      `/api/ai-runs/${encodeURIComponent(runId)}/permissions/${encodeURIComponent(permissionId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...CSRF_HEADER },
        body: JSON.stringify({ optionId }),
      },
    );
  } catch {
    throw new AiCollaborationApiError("无法连接 AI 运行服务，本次授权尚未提交");
  }
  const raw = await readJson(response);
  if (!response.ok) throw new AiCollaborationApiError(messageFrom(raw, `授权提交失败（${response.status}）`), response.status);
  return parseRunResponse(raw);
}

export async function importAiRun(runId: string): Promise<AiRun> {
  let response: Response;
  try {
    response = await fetch(`/api/ai-runs/${encodeURIComponent(runId)}/import`, {
      method: "POST",
      headers: CSRF_HEADER,
    });
  } catch {
    throw new AiCollaborationApiError("无法连接 AI 运行服务，结果尚未保存");
  }
  const raw = await readJson(response);
  if (!response.ok) throw new AiCollaborationApiError(messageFrom(raw, `结果保存失败（${response.status}）`), response.status);
  return parseRunResponse(raw);
}

export async function createAiDelivery(
  runId: string,
  input: CreateAiDeliveryInput,
): Promise<CreateAiDeliveryResult> {
  let response: Response;
  try {
    response = await fetch(`/api/ai-runs/${encodeURIComponent(runId)}/deliveries`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...CSRF_HEADER },
      body: JSON.stringify(input),
    });
  } catch {
    throw new AiCollaborationApiError("无法连接成果交付服务，尚未写入 Obsidian");
  }
  const raw = await readJson(response);
  if (!response.ok) {
    throw new AiCollaborationApiError(messageFrom(raw, `成果写入失败（${response.status}）`), response.status);
  }
  if (!raw || typeof raw !== "object") {
    throw new AiCollaborationApiError("成果交付服务返回的数据格式不正确");
  }
  const record = raw as Record<string, unknown>;
  const deliveryCandidate = record.delivery ?? raw;
  const parsedDelivery = aiDeliverySchema.safeParse(deliveryCandidate);
  if (!parsedDelivery.success) {
    throw new AiCollaborationApiError("成果交付服务返回的数据格式不正确");
  }
  const run = record.run === undefined ? null : parseRunResponse(record.run);
  return { run, delivery: parsedDelivery.data };
}

export interface AiRunSubscription {
  close: () => void;
}

export function subscribeToAiRun(
  runId: string,
  handlers: { onRun: (run: AiRun) => void; onError: () => void },
): AiRunSubscription {
  const source = new EventSource(`/api/ai-runs/${encodeURIComponent(runId)}/events`);
  const receive = (event: MessageEvent<string>) => {
    try {
      const run = parseRunResponse(JSON.parse(event.data) as unknown);
      handlers.onRun(run);
      if (!isAiRunActive(run.status)) source.close();
    } catch {
      handlers.onError();
    }
  };
  source.addEventListener("run", receive as EventListener);
  source.onerror = () => handlers.onError();
  return { close: () => source.close() };
}

export function isAiAgentRunnable(agent: AiAgentCatalogItem): boolean {
  return agent.installed
    && agent.status === "ready"
    && agent.authStatus !== "login_required"
    && agent.id !== "gemini"
    && (agent.acpMode === "native" || agent.acpMode === "conversation_cli" || agent.adapter?.installed === true);
}

export function isAiRunActive(status: AiRunStatus): boolean {
  return ["queued", "running", "waiting_permission"].includes(status);
}
