import { z } from "zod";
import { hasSecret } from "../scripts/lib/security.mjs";
import {
  AiRunConcurrencyError,
  AiRunLimitError,
  AiRunSecurityError,
  AiRunStateError,
  AiRunValidationError,
} from "./ai-collaboration/run-workspace-store.mjs";
import {
  AiRunMetadataSecurityError,
  AiRunMetadataStateError,
  AiRunMetadataValidationError,
  AiRunPermissionResolvedError,
} from "./ai-collaboration/run-metadata-db.mjs";
import {
  AiResultImportCommitError,
  AiResultImportDuplicateError,
  AiResultImportSecurityError,
  AiResultImportValidationError,
} from "./ai-collaboration/obsidian-result-importer.mjs";
import {
  AiRunServiceConflictError,
  AiRunServiceNotFoundError,
  AiRunServiceUnavailableError,
  AiRunServiceValidationError,
  createAiRunService,
} from "./ai-collaboration/ai-run-service.mjs";
import {
  AuthoritativeContextConflictError,
  AuthoritativeContextNotFoundError,
  AuthoritativeContextSecurityError,
  AuthoritativeContextTypeMismatchError,
  AuthoritativeContextValidationError,
} from "./ai-collaboration/authoritative-context-resolver.mjs";
import {
  AiTaskSourceConflictError,
  AiTaskSourceNotFoundError,
  AiTaskSourceSecurityError,
  AiTaskSourceValidationError,
} from "./ai-collaboration/task-context-resolver.mjs";
import {
  AiDeliveryCommitError,
  AiDeliveryConflictError,
  AiDeliveryValidationError,
  aiDeliveryRequestSchema,
} from "./ai-collaboration/ai-delivery-service.mjs";
import {
  ContentAssetsCommitError,
  ContentAssetsConflictError,
  ContentAssetsSecurityError,
  ContentAssetsValidationError,
} from "./content-assets-store.mjs";
import {
  ReviewAssetsCommitError,
  ReviewAssetsConflictError,
  ReviewAssetsSecurityError,
  ReviewAssetsValidationError,
} from "./review-assets-store.mjs";
import {
  DailyTasksCommitError,
  DailyTasksConflictError,
  DailyTasksSecurityError,
  DailyTasksValidationError,
} from "./daily-tasks-store.mjs";

const MAX_BODY_BYTES = 128 * 1024;
const RUN_ID_RE = /^run-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PERMISSION_ID_RE = /^perm-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const EXECUTABLE_HTML_RE = /<(?:script|style|iframe|object|embed)\b/i;
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

const cleanText = (label, max, { min = 0, multiline = true } = {}) => z.string()
  .trim()
  .min(min, `${label}不能为空`)
  .max(max, `${label}不能超过 ${max} 个字符`)
  .refine((value) => !CONTROL_RE.test(value), `${label}包含控制字符`)
  .refine((value) => multiline || !/[\r\n]/.test(value), `${label}必须是单行文字`)
  .refine((value) => !EXECUTABLE_HTML_RE.test(value), `${label}不能包含可执行 HTML`)
  .refine((value) => !hasSecret(value), `${label}不能包含凭证或密钥`);

const createRunSchema = z.object({
  provider: z.enum(["codex", "claude", "kimi", "gemini", "antigravity", "grok"]),
  templateId: z.enum([
    "analyze-topic",
    "break-down-content",
    "draft-article",
    "draft-video",
    "review-content",
    "analyze-account",
    "review-day",
    "plan-tomorrow",
  ]),
  context: z.object({
    type: z.enum(["topic", "content", "content-review", "account-breakdown", "daily-review"]),
    id: cleanText("资料 id", 160, { min: 1, multiline: false })
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/, "资料 id 不是安全的不透明标识"),
  }).strict(),
  instruction: cleanText("补充要求", 4_000).default(""),
  permissionMode: z.enum(["readonly", "ask"]),
  sourceTaskId: cleanText("来源任务 id", 80, { min: 1, multiline: false })
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/, "来源任务 id 不安全")
    .optional(),
}).strict();

const permissionBodySchema = z.object({
  optionId: cleanText("权限选项", 200, { min: 1, multiline: false }),
}).strict();

export class AiRunsApiValidationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "AiRunsApiValidationError";
    this.statusCode = statusCode;
  }
}

export class AiRunsApiSecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = "AiRunsApiSecurityError";
  }
}

function isLoopback(value) {
  const normalized = value?.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function validateBoundary(request) {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket?.remoteAddress)) {
    throw new AiRunsApiSecurityError("API 只接受本机回环连接");
  }
  const host = request.headers.host;
  if (!host || !/^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$|^\[::1\](?::\d{1,5})?$/.test(host.toLowerCase())) {
    throw new AiRunsApiSecurityError("Host 必须是本机回环地址");
  }
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    throw new AiRunsApiSecurityError("Host 请求头无效");
  }
  if (!isLoopback(hostUrl.hostname)) throw new AiRunsApiSecurityError("Host 必须是本机回环地址");

  const isWrite = request.method === "POST";
  if (isWrite && request.headers["x-cockpit-csrf"] !== "1") {
    throw new AiRunsApiSecurityError("写入请求缺少驾驶舱 CSRF 标记");
  }
  const origin = request.headers.origin;
  if (isWrite && !origin) throw new AiRunsApiSecurityError("写入请求必须包含同源 Origin");
  if (!origin) return;
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new AiRunsApiSecurityError("Origin 请求头无效");
  }
  if (
    originUrl.protocol !== "http:"
    || !isLoopback(originUrl.hostname)
    || originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()
    || originUrl.pathname !== "/"
    || originUrl.search
    || originUrl.hash
    || originUrl.username
    || originUrl.password
  ) {
    throw new AiRunsApiSecurityError("Origin 必须与驾驶舱页面同源");
  }
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) {
    throw new AiRunsApiSecurityError("跨站请求已拒绝");
  }
}

function sendJson(response, status, value) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(value));
}

async function readJson(request, schema) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
    throw new AiRunsApiValidationError("请求必须使用 application/json");
  }
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new AiRunsApiValidationError("请求体超过 128KB 安全上限", 413);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new AiRunsApiValidationError("请求体超过 128KB 安全上限", 413);
    chunks.push(chunk);
  }
  let raw;
  try {
    raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new AiRunsApiValidationError("请求体不是有效 JSON", 400, { cause: error });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AiRunsApiValidationError(parsed.error.issues[0]?.message ?? "请求字段无效");
  return parsed.data;
}

function assertNoBody(request) {
  const declared = Number(request.headers["content-length"] ?? 0);
  if ((Number.isFinite(declared) && declared > 0) || request.headers["transfer-encoding"]) {
    throw new AiRunsApiValidationError("该操作不接受请求体");
  }
}

function writeSse(response, run) {
  const seq = run.events.at(-1)?.seq ?? 0;
  response.write(`id: ${seq}\nevent: run\ndata: ${JSON.stringify(run)}\n\n`);
}

function runStreamVersion(run) {
  return {
    seq: run.events.at(-1)?.seq ?? 0,
    updatedAt: run.updatedAt ?? "",
  };
}

function isNewerRunSnapshot(run, previousVersion) {
  if (!previousVersion) return true;
  const nextVersion = runStreamVersion(run);
  if (nextVersion.seq !== previousVersion.seq) return nextVersion.seq > previousVersion.seq;
  return nextVersion.updatedAt > previousVersion.updatedAt;
}

async function handleEvents(request, response, service, runId) {
  let unsubscribe = () => {};
  let heartbeat = null;
  let streamReady = false;
  let streamClosed = false;
  let lastVersion = null;
  const queuedRuns = [];

  const cleanup = () => {
    if (streamClosed) return;
    streamClosed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
    request.removeListener("close", cleanup);
  };
  const finish = () => {
    cleanup();
    if (!response.writableEnded) response.end();
  };
  const sendSnapshot = (run) => {
    if (streamClosed || response.writableEnded || !isNewerRunSnapshot(run, lastVersion)) return;
    lastVersion = runStreamVersion(run);
    writeSse(response, run);
    if (TERMINAL_RUN_STATUSES.has(run.status)) finish();
  };
  const onRun = (run) => {
    if (!streamReady) {
      queuedRuns.push(run);
      return;
    }
    sendSnapshot(run);
  };

  unsubscribe = service.subscribe(runId, onRun);
  request.once("close", cleanup);

  let initial;
  let verified;
  try {
    initial = await service.get(runId);
    verified = await service.get(runId);
  } catch (error) {
    cleanup();
    throw error;
  }
  if (streamClosed) return;

  response.statusCode = 200;
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-store, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders?.();

  streamReady = true;
  sendSnapshot(initial);
  sendSnapshot(verified);
  for (const run of queuedRuns.splice(0)) sendSnapshot(run);
  if (streamClosed) return;

  heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(": keep-alive\n\n");
  }, 15_000);
  heartbeat.unref?.();
}

function errorResponse(error) {
  if (error instanceof AiRunsApiSecurityError
    || error instanceof AiRunSecurityError
    || error instanceof AiRunMetadataSecurityError
    || error instanceof AiResultImportSecurityError
    || error instanceof AuthoritativeContextSecurityError
    || error instanceof AiTaskSourceSecurityError
    || error instanceof ContentAssetsSecurityError
    || error instanceof ReviewAssetsSecurityError
    || error instanceof DailyTasksSecurityError) {
    return [403, "forbidden", error.message];
  }
  if (error instanceof AiRunServiceNotFoundError
    || error instanceof AuthoritativeContextNotFoundError
    || error instanceof AiTaskSourceNotFoundError) return [404, "not_found", error.message];
  if (error instanceof AiRunConcurrencyError) return [429, "too_many_active_runs", error.message];
  if (error instanceof AiRunServiceUnavailableError) return [503, "agent_unavailable", error.message];
  if (error instanceof AiRunServiceConflictError
    || error instanceof AiRunStateError
    || error instanceof AiRunMetadataStateError
    || error instanceof AiRunPermissionResolvedError
    || error instanceof AiResultImportDuplicateError
    || error instanceof AuthoritativeContextConflictError
    || error instanceof AiTaskSourceConflictError
    || error instanceof AiDeliveryConflictError
    || error instanceof ContentAssetsConflictError
    || error instanceof ReviewAssetsConflictError
    || error instanceof DailyTasksConflictError) {
    return [409, "state_conflict", error.message];
  }
  if (error instanceof AiResultImportCommitError) return [500, "import_failed", "结果写入失败，原文件未改变"];
  if (error instanceof AiDeliveryCommitError) return [500, "delivery_uncertain", error.message];
  if (error instanceof ContentAssetsCommitError) return [500, "delivery_failed", error.message];
  if (error instanceof ReviewAssetsCommitError
    || error instanceof DailyTasksCommitError) return [500, "delivery_failed", error.message];
  if (error instanceof AiRunsApiValidationError) return [error.statusCode, "invalid_request", error.message];
  if (error instanceof AiRunServiceValidationError
    || error instanceof AiRunValidationError
    || error instanceof AiRunLimitError
    || error instanceof AiRunMetadataValidationError
    || error instanceof AiResultImportValidationError
    || error instanceof AuthoritativeContextValidationError
    || error instanceof AuthoritativeContextTypeMismatchError
    || error instanceof AiTaskSourceValidationError
    || error instanceof AiDeliveryValidationError
    || error instanceof ContentAssetsValidationError
    || error instanceof ReviewAssetsValidationError
    || error instanceof DailyTasksValidationError) {
    return [400, "invalid_request", error.message];
  }
  return [500, "internal_error", "AI 协作服务处理失败"];
}

export function createAiRunsMiddleware(options = {}) {
  const service = options.service ?? createAiRunService(options);
  const middleware = async function aiRunsMiddleware(request, response, next) {
    let url;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      return next();
    }
    if (url.pathname !== "/api/ai-runs" && !url.pathname.startsWith("/api/ai-runs/")) return next();
    try {
      validateBoundary(request);
      if ([...url.searchParams].length > 0) throw new AiRunsApiValidationError("该接口不接受查询参数");

      if (url.pathname === "/api/ai-runs") {
        if (request.method === "GET") return sendJson(response, 200, await service.list());
        if (request.method === "POST") {
          const body = await readJson(request, createRunSchema);
          return sendJson(response, 202, { run: await service.create(body) });
        }
        response.setHeader("Allow", "GET, POST");
        return sendJson(response, 405, { error: "method_not_allowed", message: "仅支持 GET 和 POST" });
      }

      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length < 3 || parts[0] !== "api" || parts[1] !== "ai-runs" || !RUN_ID_RE.test(parts[2])) {
        throw new AiRunsApiValidationError("运行路径无效");
      }
      const runId = parts[2];
      if (parts.length === 3 && request.method === "GET") {
        return sendJson(response, 200, { run: await service.get(runId) });
      }
      if (parts.length === 4 && parts[3] === "events" && request.method === "GET") {
        return handleEvents(request, response, service, runId);
      }
      if (parts.length === 4 && parts[3] === "cancel" && request.method === "POST") {
        assertNoBody(request);
        return sendJson(response, 200, { run: await service.cancel(runId) });
      }
      if (parts.length === 4 && parts[3] === "import" && request.method === "POST") {
        assertNoBody(request);
        return sendJson(response, 200, { run: await service.importResult(runId) });
      }
      if (parts.length === 4 && parts[3] === "deliveries" && request.method === "POST") {
        const body = await readJson(request, aiDeliveryRequestSchema);
        const result = await service.deliverResult(runId, body);
        return sendJson(response, result.created ? 201 : 200, {
          run: result.run,
          delivery: result.delivery,
        });
      }
      if (
        parts.length === 5
        && parts[3] === "permissions"
        && PERMISSION_ID_RE.test(parts[4])
        && request.method === "POST"
      ) {
        const body = await readJson(request, permissionBodySchema);
        return sendJson(response, 200, {
          run: await service.respondPermission(runId, parts[4], body.optionId),
        });
      }
      return sendJson(response, 405, { error: "method_not_allowed", message: "该运行操作或方法不受支持" });
    } catch (error) {
      const [status, code, message] = errorResponse(error);
      return sendJson(response, status, { error: code, message });
    }
  };
  middleware.service = service;
  return middleware;
}
