import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import {
  createDailyTasksStore,
  DailyTasksCommitError,
  DailyTasksConflictError,
  DailyTasksSecurityError,
  DailyTasksValidationError,
  dailyTasksInputSchema,
  shanghaiDate,
} from "./daily-tasks-store.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const MAX_BODY_BYTES = 32 * 1024;

const putBodySchema = z.object({
  tasks: dailyTasksInputSchema,
  expectedHash: z.union([z.string().regex(/^[a-f0-9]{64}$/), z.null()]),
}).strict();

function isLoopbackHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function isLoopbackAddress(address) {
  if (!address) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function validateRequestBoundary(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) {
    throw new DailyTasksSecurityError("API 只接受本机回环连接");
  }
  const host = request.headers.host;
  if (!host) throw new DailyTasksSecurityError("缺少 Host 请求头");
  if (!/^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$|^\[::1\](?::\d{1,5})?$/.test(host.toLowerCase())) {
    throw new DailyTasksSecurityError("Host 必须是本机回环地址");
  }
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    throw new DailyTasksSecurityError("Host 请求头无效");
  }
  if (!isLoopbackHost(hostUrl.hostname)) {
    throw new DailyTasksSecurityError("Host 必须是本机回环地址");
  }
  const origin = request.headers.origin;
  if (request.method === "PUT" && !origin) {
    throw new DailyTasksSecurityError("PUT 请求必须包含同源 Origin");
  }
  if (origin) {
    let originUrl;
    try {
      originUrl = new URL(origin);
    } catch {
      throw new DailyTasksSecurityError("Origin 请求头无效");
    }
    if (originUrl.protocol !== "http:" || !isLoopbackHost(originUrl.hostname)) {
      throw new DailyTasksSecurityError("Origin 必须是本机 HTTP 回环地址");
    }
    if (
      originUrl.username
      || originUrl.password
      || originUrl.pathname !== "/"
      || originUrl.search
      || originUrl.hash
      || originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()
    ) {
      throw new DailyTasksSecurityError("Origin 必须与驾驶舱页面同源");
    }
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(body);
}

async function readJsonBody(request) {
  const contentType = request.headers["content-type"] ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new DailyTasksValidationError("PUT 请求必须使用 application/json");
  }
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    const error = new DailyTasksValidationError("请求体超过 32KB 安全上限");
    error.statusCode = 413;
    throw error;
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      const error = new DailyTasksValidationError("请求体超过 32KB 安全上限");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new DailyTasksValidationError("请求体不是有效 JSON", error);
  }
  const result = putBodySchema.safeParse(parsed);
  if (!result.success) {
    throw new DailyTasksValidationError("请求体字段无效", result.error);
  }
  return result.data;
}

let rebuildQueue = Promise.resolve();

export function rebuildAndValidateIndex({ root }) {
  const operation = rebuildQueue.catch(() => {}).then(async () => {
    const env = { ...process.env, OBSIDIAN_VAULT_ROOT: root };
    await execFileAsync(process.execPath, [path.join(projectRoot, "scripts", "build-vault-index.mjs")], {
      cwd: projectRoot,
      env,
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    await execFileAsync(process.execPath, [path.join(projectRoot, "scripts", "validate-data.mjs")], {
      cwd: projectRoot,
      env,
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
  });
  rebuildQueue = operation;
  return operation;
}

export function createDailyTasksMiddleware(options = {}) {
  const now = options.now ?? (() => new Date());
  const store = options.store ?? createDailyTasksStore({
    root: options.root,
    stateRoot: options.stateRoot,
    now,
    afterWrite: options.afterWrite ?? rebuildAndValidateIndex,
  });

  return async function dailyTasksMiddleware(request, response, next) {
    let url;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      return next();
    }
    if (url.pathname !== "/api/daily-tasks") return next();

    try {
      validateRequestBoundary(request);
      if ([...url.searchParams].length > 0) {
        throw new DailyTasksValidationError("该接口不接受日期或路径参数");
      }
      const date = shanghaiDate(now());
      if (request.method === "GET") {
        const snapshot = await store.read(date);
        return sendJson(response, 200, snapshot);
      }
      if (request.method === "PUT") {
        const body = await readJsonBody(request);
        const snapshot = await store.write(date, body.tasks, body.expectedHash);
        return sendJson(response, 200, snapshot);
      }
      response.setHeader("Allow", "GET, PUT");
      return sendJson(response, 405, { error: "method_not_allowed", message: "仅支持 GET 和 PUT" });
    } catch (error) {
      if (error instanceof DailyTasksConflictError) {
        return sendJson(response, 409, {
          error: "hash_conflict",
          message: error.message,
          current: error.current,
        });
      }
      if (error instanceof DailyTasksValidationError) {
        return sendJson(response, error.statusCode ?? 400, { error: "invalid_request", message: error.message });
      }
      if (error instanceof DailyTasksSecurityError) {
        return sendJson(response, 403, { error: "forbidden", message: error.message });
      }
      if (error instanceof DailyTasksCommitError) {
        return sendJson(response, 500, {
          error: error.rollbackError ? "rollback_failed" : "index_validation_failed",
          message: error.message,
        });
      }
      return sendJson(response, 500, { error: "internal_error", message: "今日任务保存失败" });
    }
  };
}
