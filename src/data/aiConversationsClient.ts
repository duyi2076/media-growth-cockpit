import { z } from "zod";
import { timeoutSignal } from "@/data/timeoutSignal";
import {
  aiAgentIdSchema,
  aiContextKindSchema,
  aiPermissionModeSchema,
  aiRunEventSchema,
  aiRunStatusSchema,
  aiSourceTaskSchema,
  aiTaskTemplateIdSchema,
  type AiAgentId,
  type AiPermissionMode,
  type AiRunContextReference,
} from "@/data/aiCollaborationClient";

export const aiConversationTemplateIdSchema = z.union([
  aiTaskTemplateIdSchema,
  z.literal("collaborate"),
]);
export type AiConversationTemplateId = z.infer<typeof aiConversationTemplateIdSchema>;

const aiConversationRuntimeSchema = z.object({
  providerVersion: z.string().nullable(),
  adapterPackage: z.string().nullable(),
  adapterVersion: z.string().nullable(),
  protocolVersion: z.number().int().positive().nullable(),
  versionStatus: z.enum(["current", "outdated", "newer", "unknown"]),
}).nullable().optional();

export const aiConversationTurnSchema = z.object({
  id: z.string().min(1),
  seq: z.number().int().positive(),
  clientRequestId: z.string().min(1),
  userText: z.string(),
  status: aiRunStatusSchema,
  assistantText: z.string().default(""),
  outputSha256: z.string().nullable().default(null),
  stopReason: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  events: z.array(aiRunEventSchema).default([]),
  createdAt: z.string().min(1),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
});
export type AiConversationTurn = z.infer<typeof aiConversationTurnSchema>;

export const aiConversationSchema = z.object({
  id: z.string().min(1),
  provider: aiAgentIdSchema,
  status: z.enum(["open", "closed"]),
  templateId: aiConversationTemplateIdSchema,
  context: z.object({
    type: aiContextKindSchema,
    id: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().optional(),
  }).nullable().default(null),
  sourceTask: aiSourceTaskSchema.nullable().default(null),
  permissionMode: aiPermissionModeSchema,
  runtime: aiConversationRuntimeSchema,
  revision: z.number().int().min(0),
  activeTurnId: z.string().nullable().default(null),
  acceptedTurnId: z.string().nullable().default(null),
  acceptedAt: z.string().nullable().default(null),
  importedTurnId: z.string().nullable().default(null),
  importedAt: z.string().nullable().default(null),
  importedRelativePath: z.string().nullable().default(null),
  turns: z.array(aiConversationTurnSchema).default([]),
  pendingPermission: z.object({
    id: z.string().min(1),
    turnId: z.string().optional(),
    toolCallId: z.string().min(1),
    title: z.string().min(1),
    kind: z.string().nullable().optional(),
    scope: z.array(z.string().min(1)).max(10).default([]),
    options: z.array(z.object({
      optionId: z.string().min(1),
      name: z.string().min(1),
      kind: z.enum(["allow_once", "reject_once"]),
    })),
    createdAt: z.string().min(1),
    expiresAt: z.string().min(1),
  }).nullable().default(null),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type AiConversation = z.infer<typeof aiConversationSchema>;

export interface CreateAiConversationInput {
  provider: AiAgentId;
  templateId: AiConversationTemplateId;
  context?: AiRunContextReference | null;
  permissionMode: AiPermissionMode;
  message: string;
  clientRequestId: string;
  sourceTaskId?: string;
}

export interface CreateAiConversationTurnInput {
  message: string;
  clientRequestId: string;
  expectedRevision: number;
}

export interface AcceptAiConversationTurnInput {
  turnId: string;
  outputSha256: string;
  expectedRevision: number;
}

export class AiConversationsApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "AiConversationsApiError";
    this.status = status;
  }
}

export class AiConversationConflictError extends AiConversationsApiError {
  readonly snapshot: AiConversation | null;

  constructor(message: string, snapshot: AiConversation | null) {
    super(message, 409);
    this.name = "AiConversationConflictError";
    this.snapshot = snapshot;
  }
}

const CSRF_HEADER = { "X-Cockpit-CSRF": "1" } as const;

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new AiConversationsApiError("AI 会话服务返回了无法读取的响应", response.status);
  }
}

function messageFrom(raw: unknown, fallback: string): string {
  if (!raw || typeof raw !== "object") return fallback;
  const message = (raw as Record<string, unknown>).message;
  return typeof message === "string" ? message : fallback;
}

function parseConversation(raw: unknown): AiConversation {
  const value = raw && typeof raw === "object" && "conversation" in raw
    ? (raw as Record<string, unknown>).conversation
    : raw;
  const parsed = aiConversationSchema.safeParse(value);
  if (!parsed.success) throw new AiConversationsApiError("AI 会话服务返回的数据格式不正确");
  return parsed.data;
}

async function conversationRequest(
  path: string,
  fallback: string,
  init?: RequestInit,
  conflictConversationId?: string,
): Promise<AiConversation> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new AiConversationsApiError(fallback);
  }
  const raw = await readJson(response);
  if (!response.ok) {
    const message = messageFrom(raw, `${fallback}（${response.status}）`);
    if (response.status === 409 && conflictConversationId) {
      const snapshot = await getAiConversation(conflictConversationId).catch(() => null);
      throw new AiConversationConflictError(message, snapshot);
    }
    throw new AiConversationsApiError(message, response.status);
  }
  return parseConversation(raw);
}

export async function getAiConversations(signal?: AbortSignal): Promise<AiConversation[]> {
  let response: Response;
  try {
    response = await fetch("/api/ai-conversations", {
      signal: timeoutSignal(8_000, signal),
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new AiConversationsApiError("无法连接 AI 会话服务");
  }
  const raw = await readJson(response);
  if (!response.ok) throw new AiConversationsApiError(messageFrom(raw, `会话记录读取失败（${response.status}）`), response.status);
  const value = raw && typeof raw === "object" && "conversations" in raw
    ? (raw as Record<string, unknown>).conversations
    : raw;
  const parsed = z.array(aiConversationSchema).safeParse(value);
  if (!parsed.success) throw new AiConversationsApiError("AI 会话服务返回的列表格式不正确");
  return parsed.data;
}

export function getAiConversation(id: string, signal?: AbortSignal): Promise<AiConversation> {
  return conversationRequest(
    `/api/ai-conversations/${encodeURIComponent(id)}`,
    "会话读取失败",
    { signal: timeoutSignal(8_000, signal), cache: "no-store" },
  );
}

export function createAiConversation(input: CreateAiConversationInput): Promise<AiConversation> {
  return conversationRequest("/api/ai-conversations", "会话尚未开始", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...CSRF_HEADER },
    body: JSON.stringify(input),
  });
}

export function createAiConversationTurn(
  conversationId: string,
  input: CreateAiConversationTurnInput,
): Promise<AiConversation> {
  return conversationRequest(
    `/api/ai-conversations/${encodeURIComponent(conversationId)}/turns`,
    "消息尚未发送",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...CSRF_HEADER },
      body: JSON.stringify(input),
    },
    conversationId,
  );
}

export function cancelAiConversationTurn(conversationId: string, turnId: string): Promise<AiConversation> {
  return conversationRequest(
    `/api/ai-conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/cancel`,
    "当前回复尚未停止",
    { method: "POST", headers: CSRF_HEADER },
    conversationId,
  );
}

export function respondAiConversationPermission(
  conversationId: string,
  turnId: string,
  permissionId: string,
  optionId: string,
): Promise<AiConversation> {
  return conversationRequest(
    `/api/ai-conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/permissions/${encodeURIComponent(permissionId)}`,
    "权限决定尚未提交",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...CSRF_HEADER },
      body: JSON.stringify({ optionId }),
    },
    conversationId,
  );
}

export function acceptAiConversationTurn(
  conversationId: string,
  input: AcceptAiConversationTurnInput,
): Promise<AiConversation> {
  return conversationRequest(
    `/api/ai-conversations/${encodeURIComponent(conversationId)}/accept`,
    "最终版本尚未采用",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...CSRF_HEADER },
      body: JSON.stringify(input),
    },
    conversationId,
  );
}

export function importAiConversation(conversationId: string): Promise<AiConversation> {
  return conversationRequest(
    `/api/ai-conversations/${encodeURIComponent(conversationId)}/import`,
    "最终成果尚未保存",
    { method: "POST", headers: CSRF_HEADER },
    conversationId,
  );
}

export function closeAiConversation(conversationId: string): Promise<AiConversation> {
  return conversationRequest(
    `/api/ai-conversations/${encodeURIComponent(conversationId)}/close`,
    "会话尚未关闭",
    { method: "POST", headers: CSRF_HEADER },
    conversationId,
  );
}

export interface AiConversationSubscription {
  close: () => void;
}

export function subscribeToAiConversation(
  conversationId: string,
  handlers: { onConversation: (conversation: AiConversation) => void; onError: () => void },
): AiConversationSubscription {
  const source = new EventSource(`/api/ai-conversations/${encodeURIComponent(conversationId)}/events`);
  const receive = (event: MessageEvent<string>) => {
    try {
      handlers.onConversation(parseConversation(JSON.parse(event.data) as unknown));
    } catch {
      handlers.onError();
    }
  };
  source.addEventListener("conversation", receive as EventListener);
  source.onmessage = receive;
  source.onerror = () => handlers.onError();
  return { close: () => source.close() };
}

export function isAiConversationTurnActive(turn: AiConversationTurn | null | undefined): boolean {
  return Boolean(turn && ["queued", "running", "waiting_permission"].includes(turn.status));
}
