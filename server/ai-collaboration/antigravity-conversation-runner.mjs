import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ACP_MAX_FINAL_TEXT_BYTES,
  ACP_TURN_TIMEOUT_MS,
  AcpRunnerTimeoutError,
  AcpRunnerUnavailableError,
  AcpRunnerValidationError,
} from "./acp-runner.mjs";
import { redactSensitiveString } from "./redaction.mjs";

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const EVENT_CHUNK_BYTES = 48 * 1024;

function assertOptions(options) {
  if (options?.launch?.provider !== "antigravity") throw new AcpRunnerValidationError("Antigravity 启动配置无效");
  if (typeof options.launch.executable !== "string" || !path.isAbsolute(options.launch.executable) || options.launch.executable.includes("\0")) {
    throw new AcpRunnerValidationError("Antigravity 可执行文件必须是已验证绝对路径");
  }
  if (typeof options.cwd !== "string" || !path.isAbsolute(options.cwd) || options.cwd.includes("\0")) {
    throw new AcpRunnerValidationError("会话工作区必须是绝对路径");
  }
  if (options.permissionMode === "ask") throw new AcpRunnerValidationError("Antigravity 当前只开放只读协作");
}

function processStillRunning(child) {
  return child?.exitCode === null && child?.signalCode === null;
}

function terminateProcessGroup(child, signal = "SIGTERM") {
  if (!child?.pid || !processStillRunning(child)) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* process already exited */ }
  }
}

function chunkText(value) {
  const chunks = [];
  let current = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (current && bytes + size > EVENT_CHUNK_BYTES) {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += character;
    bytes += size;
  }
  if (current) chunks.push(current);
  return chunks;
}

async function readSessionId(logPath) {
  let stat;
  try { stat = await fs.stat(logPath); } catch { return null; }
  if (!stat.isFile() || stat.size > MAX_LOG_BYTES) return null;
  const log = await fs.readFile(logPath, "utf8");
  const matches = [...log.matchAll(/(?:conversationID="|Created conversation |Print mode: conversation=)([0-9a-f-]{36})"?/gi)]
    .map((match) => match[1])
    .filter((value) => SESSION_ID_RE.test(value));
  return matches.at(-1) ?? null;
}

export function createAntigravityConversationRunner(options) {
  assertOptions(options);
  const spawnProcess = options.spawnProcess ?? spawn;
  const savedId = options.savedSession?.providerSessionId;
  let providerSessionId = typeof savedId === "string" && SESSION_ID_RE.test(savedId) ? savedId : null;
  let child = null;
  let activeController = null;
  let closed = false;

  async function prompt(input) {
    if (closed) throw new AcpRunnerUnavailableError("Antigravity 会话已经结束");
    if (child) throw new AcpRunnerUnavailableError("Antigravity 正在回复上一条消息");
    if (typeof input?.text !== "string" || !input.text.trim()) throw new AcpRunnerValidationError("消息不能为空");

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "creator-antigravity-"));
    const logPath = path.join(tempRoot, "session.log");
    const args = ["--mode", "plan", "--sandbox", "--print-timeout", "10m", "--log-file", logPath];
    if (providerSessionId) args.push("--conversation", providerSessionId);
    args.push("--print", input.text);

    const controller = new AbortController();
    activeController = controller;
    const abort = () => controller.abort(input.signal?.reason ?? new DOMException("Cancelled", "AbortError"));
    if (input.signal?.aborted) abort(); else input.signal?.addEventListener("abort", abort, { once: true });

    let stdout = "";
    let stderr = "";
    let outputTooLarge = false;
    let timeout;
    try {
      const result = await new Promise((resolve, reject) => {
        child = spawnProcess(options.launch.executable, args, {
          cwd: options.cwd,
          env: options.launch.env,
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        const fail = (error) => { cleanup(); reject(error); };
        const finish = (code, signal) => { cleanup(); resolve({ code, signal }); };
        const onAbort = () => {
          terminateProcessGroup(child);
          const killTimer = setTimeout(() => terminateProcessGroup(child, "SIGKILL"), 1_500);
          killTimer.unref?.();
        };
        const cleanup = () => {
          clearTimeout(timeout);
          controller.signal.removeEventListener("abort", onAbort);
          child?.removeListener("error", fail);
          child?.removeListener("close", finish);
        };
        controller.signal.addEventListener("abort", onAbort, { once: true });
        child.once("error", fail);
        child.once("close", finish);
        child.stdout?.on("data", (chunk) => {
          stdout += chunk.toString("utf8");
          if (Buffer.byteLength(stdout, "utf8") > ACP_MAX_FINAL_TEXT_BYTES) {
            outputTooLarge = true;
            controller.abort(new AcpRunnerValidationError("Antigravity 输出超过 2MiB 安全上限"));
          }
        });
        child.stderr?.on("data", (chunk) => {
          if (Buffer.byteLength(stderr, "utf8") < MAX_STDERR_BYTES) stderr += chunk.toString("utf8");
        });
        timeout = setTimeout(() => controller.abort(new AcpRunnerTimeoutError("Antigravity 回复超时")), options.turnTimeoutMs ?? ACP_TURN_TIMEOUT_MS);
        timeout.unref?.();
        if (controller.signal.aborted) onAbort();
      });

      if (controller.signal.aborted) {
        if (outputTooLarge) throw new AcpRunnerValidationError("Antigravity 输出超过 2MiB 安全上限");
        const reason = controller.signal.reason;
        if (reason instanceof AcpRunnerTimeoutError) throw reason;
        throw new DOMException("Cancelled", "AbortError");
      }
      if (result.code !== 0) {
        const safeDiagnostic = redactSensitiveString(stderr);
        if (/(?:login|authentication|unauthori[sz]ed|credential)/i.test(safeDiagnostic)) {
          throw new AcpRunnerUnavailableError("Antigravity 需要先完成登录");
        }
        throw new AcpRunnerUnavailableError("Antigravity 未能完成本轮回复");
      }

      if (!providerSessionId) {
        providerSessionId = await readSessionId(logPath);
        if (!providerSessionId) throw new AcpRunnerUnavailableError("Antigravity 未返回可恢复的会话标识");
        await options.onSession?.({ providerSessionId, transport: "antigravity-cli" });
      }

      const finalText = redactSensitiveString(stdout).trim();
      if (!finalText) throw new AcpRunnerUnavailableError("Antigravity 没有返回可见内容");
      for (const text of chunkText(finalText)) await input.onEvent?.({ type: "message", text });
      return { finalText, stopReason: "end_turn" };
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
      activeController = null;
      child = null;
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function cancel() {
    activeController?.abort(new DOMException("Cancelled", "AbortError"));
    terminateProcessGroup(child);
  }

  async function close() {
    if (closed) return;
    closed = true;
    await cancel();
  }

  return {
    get connected() { return !closed; },
    prompt,
    cancel,
    close,
    suspend: close,
  };
}
