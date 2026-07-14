import { z } from "zod";
import { hasSecret } from "../scripts/lib/security.mjs";
import {
  AiConversationConflictError,
  AiConversationLimitError,
  AiConversationNotFoundError,
  AiConversationSecurityError,
  AiConversationValidationError,
} from "./ai-collaboration/conversation-workspace-store.mjs";
import {
  AiConversationServiceConflictError,
  AiConversationServiceNotFoundError,
  AiConversationServiceUnavailableError,
  AiConversationServiceValidationError,
  createAiConversationService,
} from "./ai-collaboration/ai-conversation-service.mjs";
import {
  AiConversationImportCommitError,
  AiConversationImportConflictError,
  AiConversationImportSecurityError,
  AiConversationImportValidationError,
} from "./ai-collaboration/conversation-result-importer.mjs";

const MAX_BODY_BYTES = 128 * 1024;
const CONVERSATION_ID_RE = /^conv-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TURN_ID_RE = /^turn-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PERMISSION_ID_RE = /^perm-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const EXECUTABLE_HTML_RE = /<(?:script|style|iframe|object|embed)\b/i;

const cleanText = (label, max, { min = 0, multiline = true } = {}) => z.string()
  .trim()
  .min(min, `${label}不能为空`)
  .max(max, `${label}不能超过 ${max} 个字符`)
  .refine((value) => !CONTROL_RE.test(value), `${label}包含控制字符`)
  .refine((value) => multiline || !/[\r\n]/.test(value), `${label}必须是单行文字`)
  .refine((value) => !EXECUTABLE_HTML_RE.test(value), `${label}不能包含可执行 HTML`)
  .refine((value) => !hasSecret(value), `${label}不能包含凭证或密钥`);

const contextSchema = z.object({
  type: z.enum(["topic", "content", "content-review", "account-breakdown", "daily-review"]),
  id: cleanText("资料 id", 160, { min: 1, multiline: false }).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/, "资料 id 不安全"),
}).strict();

const createSchema = z.object({
  provider: z.enum(["codex", "claude", "kimi", "gemini", "antigravity", "grok"]),
  templateId: z.enum([
    "collaborate", "analyze-topic", "break-down-content", "draft-article", "draft-video",
    "review-content", "analyze-account", "review-day", "plan-tomorrow",
  ]).default("collaborate"),
  context: contextSchema.nullable().optional(),
  permissionMode: z.enum(["readonly", "ask"]).default("readonly"),
  message: cleanText("消息", 20_000, { min: 1 }),
  clientRequestId: cleanText("clientRequestId", 128, { min: 1, multiline: false })
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, "clientRequestId 格式无效"),
  sourceTaskId: cleanText("来源任务 id", 80, { min: 1, multiline: false })
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/, "来源任务 id 不安全").optional(),
}).strict();

const turnSchema = z.object({
  message: cleanText("消息", 20_000, { min: 1 }),
  clientRequestId: cleanText("clientRequestId", 128, { min: 1, multiline: false })
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, "clientRequestId 格式无效"),
  expectedRevision: z.number().int().positive(),
}).strict();

const permissionSchema = z.object({
  optionId: cleanText("权限选项", 200, { min: 1, multiline: false }),
}).strict();

const acceptSchema = z.object({
  turnId: z.string().regex(TURN_ID_RE, "turnId 格式无效"),
  outputSha256: z.string().regex(/^[a-f0-9]{64}$/, "outputSha256 格式无效"),
  expectedRevision: z.number().int().positive(),
}).strict();

export class AiConversationsApiValidationError extends Error {
  constructor(message, statusCode = 400) { super(message); this.name = "AiConversationsApiValidationError"; this.statusCode = statusCode; }
}
export class AiConversationsApiSecurityError extends Error {
  constructor(message) { super(message); this.name = "AiConversationsApiSecurityError"; }
}

function isLoopback(value) {
  const host = value?.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function validateBoundary(request) {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket?.remoteAddress)) {
    throw new AiConversationsApiSecurityError("API 只接受本机回环连接");
  }
  const host = request.headers.host;
  if (!host || !/^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$|^\[::1\](?::\d{1,5})?$/.test(host.toLowerCase())) {
    throw new AiConversationsApiSecurityError("Host 必须是本机回环地址");
  }
  const hostUrl = new URL(`http://${host}`);
  if (!isLoopback(hostUrl.hostname)) throw new AiConversationsApiSecurityError("Host 必须是本机回环地址");
  if (request.method === "POST") {
    if (request.headers["x-cockpit-csrf"] !== "1") throw new AiConversationsApiSecurityError("写入请求缺少 CSRF 标记");
    const origin = request.headers.origin;
    if (!origin) throw new AiConversationsApiSecurityError("写入请求必须包含同源 Origin");
    let originUrl;
    try { originUrl = new URL(origin); } catch { throw new AiConversationsApiSecurityError("Origin 无效"); }
    if (originUrl.protocol !== "http:" || !isLoopback(originUrl.hostname) || originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()
      || originUrl.pathname !== "/" || originUrl.search || originUrl.hash || originUrl.username || originUrl.password) {
      throw new AiConversationsApiSecurityError("Origin 必须与驾驶舱页面同源");
    }
  }
  const site = request.headers["sec-fetch-site"];
  if (site && !["same-origin", "none"].includes(site)) throw new AiConversationsApiSecurityError("跨站请求已拒绝");
}

function sendJson(response, status, value) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(value));
}

async function readJson(request, schema) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) throw new AiConversationsApiValidationError("请求必须使用 application/json");
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new AiConversationsApiValidationError("请求体超过 128KB", 413);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new AiConversationsApiValidationError("请求体超过 128KB", 413);
    chunks.push(chunk);
  }
  let raw;
  try { raw = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new AiConversationsApiValidationError("请求体不是有效 JSON"); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AiConversationsApiValidationError(parsed.error.issues[0]?.message ?? "请求字段无效");
  return parsed.data;
}

function assertNoBody(request) {
  const declared = Number(request.headers["content-length"] ?? 0);
  if ((Number.isFinite(declared) && declared > 0) || request.headers["transfer-encoding"]) throw new AiConversationsApiValidationError("该操作不接受请求体");
}

function cursorFor(conversation) {
  const eventCount = conversation.turns.reduce((sum, turn) => sum + turn.events.length, 0);
  return `${conversation.revision}:${eventCount}`;
}

async function handleEvents(request, response, service, conversationId) {
  let unsubscribe = () => {};
  let heartbeat = null;
  let ready = false;
  let closed = false;
  let lastCursor = null;
  const queued = [];
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    request.removeListener("close", cleanup);
  };
  const send = (conversation) => {
    if (closed || response.writableEnded) return;
    const cursor = cursorFor(conversation);
    if (cursor === lastCursor) return;
    lastCursor = cursor;
    response.write(`id: ${cursor}\nevent: conversation\ndata: ${JSON.stringify(conversation)}\n\n`);
    if (conversation.status === "closed") {
      cleanup();
      response.end();
    }
  };
  const listener = (conversation) => { if (!ready) queued.push(conversation); else send(conversation); };
  unsubscribe = service.subscribe(conversationId, listener);
  request.once("close", cleanup);
  let initial;
  try { initial = await service.get(conversationId); } catch (error) { cleanup(); throw error; }
  if (closed) return;
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-store, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders?.();
  ready = true;
  send(initial);
  for (const value of queued.splice(0)) send(value);
  if (closed) return;
  heartbeat = setInterval(() => { if (!response.writableEnded) response.write(": keep-alive\n\n"); }, 15_000);
  heartbeat.unref?.();
}

function errorResponse(error) {
  if (error instanceof AiConversationsApiSecurityError || error instanceof AiConversationSecurityError || error instanceof AiConversationImportSecurityError) return [403, "forbidden", error.message];
  if (error instanceof AiConversationServiceNotFoundError || error instanceof AiConversationNotFoundError) return [404, "not_found", error.message];
  if (error instanceof AiConversationServiceUnavailableError) return [503, "agent_unavailable", error.message];
  if (error instanceof AiConversationServiceConflictError || error instanceof AiConversationConflictError || error instanceof AiConversationImportConflictError) return [409, "state_conflict", error.message];
  if (error instanceof AiConversationLimitError) return [413, "limit_exceeded", error.message];
  if (error instanceof AiConversationImportCommitError) return [500, "import_failed", error.message];
  if (error instanceof AiConversationsApiValidationError) return [error.statusCode, "invalid_request", error.message];
  if (error instanceof AiConversationServiceValidationError || error instanceof AiConversationValidationError || error instanceof AiConversationImportValidationError) return [400, "invalid_request", error.message];
  return [500, "internal_error", "AI 会话服务处理失败"];
}

export function createAiConversationsMiddleware(options = {}) {
  const service = options.service ?? createAiConversationService(options);
  const middleware = async function aiConversationsMiddleware(request, response, next) {
    let url;
    try { url = new URL(request.url ?? "/", "http://127.0.0.1"); } catch { return next(); }
    if (url.pathname !== "/api/ai-conversations" && !url.pathname.startsWith("/api/ai-conversations/")) return next();
    try {
      validateBoundary(request);
      if ([...url.searchParams].length) throw new AiConversationsApiValidationError("该接口不接受查询参数");
      if (url.pathname === "/api/ai-conversations") {
        if (request.method === "GET") return sendJson(response, 200, await service.list());
        if (request.method === "POST") return sendJson(response, 202, { conversation: await service.create(await readJson(request, createSchema)) });
        response.setHeader("Allow", "GET, POST");
        return sendJson(response, 405, { error: "method_not_allowed", message: "仅支持 GET 和 POST" });
      }
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "api" || parts[1] !== "ai-conversations" || !CONVERSATION_ID_RE.test(parts[2] ?? "")) throw new AiConversationsApiValidationError("会话路径无效");
      const conversationId = parts[2];
      if (parts.length === 3 && request.method === "GET") return sendJson(response, 200, { conversation: await service.get(conversationId) });
      if (parts.length === 4 && parts[3] === "events" && request.method === "GET") return handleEvents(request, response, service, conversationId);
      if (parts.length === 4 && parts[3] === "turns" && request.method === "POST") {
        const result = await service.addTurn(conversationId, await readJson(request, turnSchema));
        return sendJson(response, result.created ? 202 : 200, { conversation: result.conversation });
      }
      if (parts.length === 6 && parts[3] === "turns" && TURN_ID_RE.test(parts[4]) && parts[5] === "cancel" && request.method === "POST") {
        assertNoBody(request);
        return sendJson(response, 200, { conversation: await service.cancelTurn(conversationId, parts[4]) });
      }
      if (parts.length === 7 && parts[3] === "turns" && TURN_ID_RE.test(parts[4]) && parts[5] === "permissions" && PERMISSION_ID_RE.test(parts[6]) && request.method === "POST") {
        return sendJson(response, 200, { conversation: await service.respondPermission(conversationId, parts[4], parts[6], (await readJson(request, permissionSchema)).optionId) });
      }
      if (parts.length === 4 && parts[3] === "accept" && request.method === "POST") {
        return sendJson(response, 200, { conversation: await service.accept(conversationId, await readJson(request, acceptSchema)) });
      }
      if (parts.length === 4 && parts[3] === "import" && request.method === "POST") {
        assertNoBody(request);
        return sendJson(response, 200, { conversation: await service.importResult(conversationId) });
      }
      if (parts.length === 4 && parts[3] === "close" && request.method === "POST") {
        assertNoBody(request);
        return sendJson(response, 200, { conversation: await service.closeConversation(conversationId) });
      }
      return sendJson(response, 405, { error: "method_not_allowed", message: "该会话操作或方法不受支持" });
    } catch (error) {
      const [status, code, message] = errorResponse(error);
      return sendJson(response, status, { error: code, message });
    }
  };
  middleware.service = service;
  return middleware;
}
