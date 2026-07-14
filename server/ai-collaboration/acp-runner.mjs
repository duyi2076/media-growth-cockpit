import { spawn } from "node:child_process";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { redactAiLogValue, redactSensitiveString } from "./redaction.mjs";

const PROVIDER_IDS = new Set(["codex", "claude", "kimi", "gemini", "antigravity", "grok"]);
const RUNTIME_ENV_KEYS = Object.freeze([
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "NO_COLOR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);

export const ACP_INITIALIZE_TIMEOUT_MS = 5_000;
export const ACP_PERMISSION_TIMEOUT_MS = 60_000;
export const ACP_TURN_TIMEOUT_MS = 10 * 60_000;
export const ACP_MAX_FINAL_TEXT_BYTES = 2 * 1024 * 1024;
// Keep one streamed text chunk below the 64 KiB persistence envelope after
// JSON framing and metadata are added by the workspace and SQLite stores.
const ACP_MAX_EVENT_TEXT_BYTES = 48 * 1024;
const ACP_MAX_STDERR_BYTES = 16 * 1024;

export class AcpRunnerValidationError extends Error {}
export class AcpRunnerUnavailableError extends Error {}
export class AcpRunnerTimeoutError extends Error {}

const PROVIDER_DISPLAY_NAMES = Object.freeze({
  codex: "Codex",
  claude: "Claude Code",
  kimi: "Kimi Code",
  gemini: "Gemini CLI",
  antigravity: "Antigravity",
  grok: "Grok Build",
});

function assertAbsoluteExecutable(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw new AcpRunnerValidationError(`${label}必须是已验证的绝对路径`);
  }
  return value;
}

export function createMinimalRuntimeEnvironment(source = process.env) {
  const env = Object.create(null);
  for (const key of RUNTIME_ENV_KEYS) {
    if (typeof source[key] === "string") env[key] = source[key];
  }
  const runtimeBin = path.dirname(process.execPath);
  const pathEntries = [runtimeBin, ...(env.PATH ?? "").split(path.delimiter)]
    .filter((entry, index, entries) => entry && entries.indexOf(entry) === index);
  env.PATH = pathEntries.join(path.delimiter);
  env.NO_COLOR = "1";
  return env;
}

/**
 * Converts an Agent Catalog snapshot into one of five fixed launch recipes.
 * No user-controlled executable, argv, or environment value is accepted here.
 */
export function createProviderLaunch(agent, options = {}) {
  if (!agent || !PROVIDER_IDS.has(agent.id)) {
    throw new AcpRunnerValidationError("不支持的 AI Provider");
  }
  if (!agent.installed || agent.status !== "ready") {
    throw new AcpRunnerUnavailableError(`${agent.displayName ?? agent.id} 当前不可用`);
  }
  const permissionMode = options.permissionMode === "ask" ? "ask" : "readonly";
  const cliPath = assertAbsoluteExecutable(agent.executablePath, "CLI 路径");
  const env = createMinimalRuntimeEnvironment(options.env ?? process.env);

  switch (agent.id) {
    case "codex": {
      const adapterPath = assertAbsoluteExecutable(agent.adapter?.executablePath, "Codex ACP 适配器路径");
      return {
        provider: agent.id,
        executable: adapterPath,
        args: [],
        env: {
          ...env,
          CODEX_PATH: cliPath,
          INITIAL_AGENT_MODE: permissionMode === "readonly" ? "read-only" : "agent",
          NO_BROWSER: "1",
        },
      };
    }
    case "claude": {
      const adapterPath = assertAbsoluteExecutable(agent.adapter?.executablePath, "Claude ACP 适配器路径");
      return {
        provider: agent.id,
        executable: adapterPath,
        args: [],
        env: { ...env, CLAUDE_CODE_EXECUTABLE: cliPath },
      };
    }
    case "kimi":
      return { provider: agent.id, executable: cliPath, args: ["acp"], env };
    case "antigravity":
      return { provider: agent.id, executable: cliPath, args: [], env };
    case "gemini":
      return {
        provider: agent.id,
        executable: cliPath,
        args: [
          "--acp",
          "--approval-mode",
          permissionMode === "readonly" ? "plan" : "default",
          "--skip-trust",
        ],
        env,
      };
    case "grok":
      return { provider: agent.id, executable: cliPath, args: ["agent", "stdio"], env };
    default:
      throw new AcpRunnerValidationError("不支持的 AI Provider");
  }
}
function byteLimitedText(value, maxBytes = ACP_MAX_EVENT_TEXT_BYTES) {
  const redacted = redactSensitiveString(value ?? "");
  const bytes = Buffer.from(redacted, "utf8");
  if (bytes.byteLength <= maxBytes) return redacted;
  return `${bytes.subarray(0, maxBytes).toString("utf8")}\n[内容已截断]`;
}

function safeDetails(value) {
  const redacted = redactAiLogValue(value);
  const serialized = JSON.stringify(redacted);
  if (Buffer.byteLength(serialized, "utf8") <= ACP_MAX_EVENT_TEXT_BYTES) return redacted;
  return { truncated: true };
}

export function classifyAcpFailure(provider, stderr, error) {
  const messages = [];
  const seen = new Set();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current) && messages.length < 6) {
    seen.add(current);
    if (typeof current.message === "string") messages.push(current.message);
    current = current.cause;
  }
  const diagnostic = `${stderr ?? ""}\n${messages.join("\n")}`;
  if (
    provider === "gemini"
    && /(?:IneligibleTierError|UNSUPPORTED_CLIENT|client is no longer supported|migrate to (?:the )?Antigravity)/i.test(diagnostic)
  ) {
    return "Gemini CLI 当前认证方式不受支持，请在终端完成官方迁移或改用企业/API Key 登录后重试";
  }
  if (/(?:authentication required|login required|not logged in|unauthori[sz]ed|invalid credentials|HTTP\s*401)/i.test(diagnostic)) {
    return `${PROVIDER_DISPLAY_NAMES[provider] ?? "Agent"} 需要先在终端完成登录`;
  }
  return stderr ? "Agent 进程异常退出" : "Agent 运行失败";
}

export function stripProviderRuntimeNotices(provider, value) {
  const text = typeof value === "string" ? value : "";
  if (provider !== "codex") return text;
  return text.replace(
    /^Warning: Skill descriptions were shortened to fit the 2% skills context budget\. Codex can still see every skill, but some descriptions are shorter\. Disable unused skills or plugins to leave more room for the rest\.\s*/,
    "",
  );
}

function eventFromUpdate(update) {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return update.content?.type === "text"
        ? { type: "message", text: byteLimitedText(update.content.text) }
        : { type: "message", text: `[${update.content?.type ?? "content"}]` };
    case "agent_thought_chunk":
      return update.content?.type === "text"
        ? { type: "thought", text: byteLimitedText(update.content.text) }
        : { type: "thought", text: "Agent 正在思考" };
    case "plan":
      return { type: "plan", title: "执行计划", details: safeDetails(update) };
    case "tool_call":
      return {
        type: "tool_call",
        toolCallId: update.toolCallId,
        title: byteLimitedText(update.title ?? "工具调用", 2_048),
        status: update.status ?? "pending",
        details: safeDetails({ kind: update.kind, locations: update.locations }),
      };
    case "tool_call_update":
      return {
        type: "tool_update",
        toolCallId: update.toolCallId,
        title: byteLimitedText(update.title ?? "工具调用更新", 2_048),
        status: update.status ?? "in_progress",
        details: safeDetails({ kind: update.kind, locations: update.locations, content: update.content }),
      };
    case "available_commands_update":
    case "current_mode_update":
    case "config_option_update":
      return { type: "status", title: "Agent 状态已更新", details: safeDetails(update) };
    default:
      return null;
  }
}

function onceAbort(signal) {
  if (!signal) return { promise: new Promise(() => {}), dispose() {} };
  let listener;
  const promise = new Promise((_, reject) => {
    listener = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (signal.aborted) listener();
    else signal.addEventListener("abort", listener, { once: true });
  });
  return { promise, dispose: () => signal.removeEventListener("abort", listener) };
}

function onceProcessError(child) {
  let listener;
  const promise = new Promise((_, reject) => {
    listener = (error) => reject(new AcpRunnerUnavailableError("Agent 启动失败，请刷新状态后重试", { cause: error }));
    child.once("error", listener);
  });
  return { promise, dispose: () => child.removeListener("error", listener) };
}

function processStillRunning(child) {
  return child?.exitCode === null && child?.signalCode === null;
}

function resolveEventTimestamp(now) {
  const value = now?.() ?? new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new AcpRunnerValidationError("事件时间无效");
  return date.toISOString();
}

async function withTimeout(promise, timeoutMs, label, controller) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller?.abort(new AcpRunnerTimeoutError(`${label}超时`));
          reject(new AcpRunnerTimeoutError(`${label}超时`));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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

function waitForExit(child, timeoutMs) {
  if (!processStillRunning(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

function normalizedPermission(params) {
  const options = (params.options ?? [])
    .filter((option) => option.kind === "allow_once" || option.kind === "reject_once")
    .map((option) => ({
      optionId: String(option.optionId),
      name: byteLimitedText(option.name, 2_048),
      kind: option.kind,
    }));
  return {
    toolCallId: String(params.toolCall?.toolCallId ?? "unknown"),
    title: byteLimitedText(params.toolCall?.title ?? "敏感操作", 2_048),
    kind: params.toolCall?.kind ?? undefined,
    options,
    details: safeDetails({ locations: params.toolCall?.locations }),
  };
}

async function decidePermission(params, options) {
  const request = normalizedPermission(params);
  const rejectOption = request.options.find((option) => option.kind === "reject_once");
  if (options.permissionMode !== "ask") {
    return rejectOption
      ? { outcome: { outcome: "selected", optionId: rejectOption.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }
  if (!request.options.length || typeof options.requestPermission !== "function") {
    return { outcome: { outcome: "cancelled" } };
  }

  const controller = new AbortController();
  const result = await withTimeout(
    Promise.resolve(options.requestPermission(request, controller.signal)),
    options.permissionTimeoutMs ?? ACP_PERMISSION_TIMEOUT_MS,
    "权限确认",
    controller,
  ).catch(() => null);
  const selected = request.options.find((option) => option.optionId === result?.optionId);
  if (!selected) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: selected.optionId } };
}

async function enforceProviderSessionMode(ctx, session, provider, permissionMode, emit) {
  const modeByProvider = permissionMode === "readonly"
    ? { codex: "read-only", claude: "plan" }
    : { codex: "agent", claude: "default" };
  const modeId = modeByProvider[provider];
  if (!modeId) return null;
  const available = session.modes?.availableModes ?? [];
  if (!available.some((mode) => mode.id === modeId)) {
    throw new AcpRunnerUnavailableError(`${PROVIDER_DISPLAY_NAMES[provider]} 未提供所需的安全运行模式`);
  }
  if (session.modes?.currentModeId !== modeId) {
    await ctx.request(acp.methods.agent.session.setMode, { sessionId: session.sessionId, modeId });
  }
  await emit({
    type: "status",
    status: "mode_enforced",
    title: permissionMode === "readonly" ? "已启用 Agent 原生只读模式" : "已启用逐次确认模式",
    details: { modeId },
  });
  return modeId;
}

/**
 * Runs one prompt turn against an ACP stdio agent. The caller owns persistence,
 * event sequencing, and the AbortController used for cancellation.
 */
export async function runAcpSession(options) {
  const launch = options.launch;
  const cwd = options.cwd;
  if (!launch || !PROVIDER_IDS.has(launch.provider)) throw new AcpRunnerValidationError("无效启动配置");
  assertAbsoluteExecutable(launch.executable, "Agent 可执行文件");
  if (!Array.isArray(launch.args) || launch.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new AcpRunnerValidationError("Agent 参数无效");
  }
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) || cwd.includes("\0")) {
    throw new AcpRunnerValidationError("任务工作区必须是绝对路径");
  }
  if (typeof options.prompt !== "string" || !options.prompt.trim()) {
    throw new AcpRunnerValidationError("任务指令不能为空");
  }

  const emit = async (event) => options.onEvent?.({
    ...event,
    createdAt: resolveEventTimestamp(options.now),
  });
  const child = (options.spawnProcess ?? spawn)(launch.executable, [...launch.args], {
    cwd,
    env: { ...launch.env },
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const processError = onceProcessError(child);
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = byteLimitedText(`${stderr}${chunk}`, ACP_MAX_STDERR_BYTES);
  });

  const cancelController = new AbortController();
  const callerAbort = () => cancelController.abort(options.signal?.reason ?? new DOMException("Aborted", "AbortError"));
  if (options.signal?.aborted) callerAbort();
  else options.signal?.addEventListener("abort", callerAbort, { once: true });

  let acpContext = null;
  let providerSessionId = null;
  const abortWait = onceAbort(cancelController.signal);
  const gracefulCancel = async () => {
    if (acpContext && providerSessionId) {
      await acpContext.notify(acp.methods.agent.session.cancel, { sessionId: providerSessionId }).catch(() => {});
    }
    const exited = await waitForExit(child, 3_000);
    if (!exited) {
      terminateProcessGroup(child, "SIGTERM");
      if (!(await waitForExit(child, 2_000))) terminateProcessGroup(child, "SIGKILL");
    }
  };
  cancelController.signal.addEventListener("abort", () => { void gracefulCancel(); }, { once: true });

  const input = Writable.toWeb(child.stdin);
  const output = Readable.toWeb(child.stdout);
  const stream = acp.ndJsonStream(input, output);
  let finalText = "";
  let capabilities = null;
  try {
    await emit({ type: "status", status: "starting", title: "正在连接 Agent" });
    const result = await Promise.race([
      acp
        .client({ name: "media-growth-cockpit" })
        .onRequest(acp.methods.client.session.requestPermission, (ctx) => decidePermission(ctx.params, options))
        .connectWith(stream, async (ctx) => {
          acpContext = ctx;
          const initController = new AbortController();
          const initialized = await withTimeout(
            ctx.request(acp.methods.agent.initialize, {
              protocolVersion: acp.PROTOCOL_VERSION,
              clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
            }, { cancellationSignal: initController.signal }),
            options.initializeTimeoutMs ?? ACP_INITIALIZE_TIMEOUT_MS,
            "ACP 初始化",
            initController,
          );
          capabilities = redactAiLogValue({
            protocolVersion: initialized.protocolVersion,
            agentCapabilities: initialized.agentCapabilities,
            authMethods: initialized.authMethods?.map((method) => ({ id: method.id, name: method.name })) ?? [],
          });
          await emit({ type: "status", status: "connected", title: "Agent 已连接", details: capabilities });

          return ctx.buildSession(cwd).withSession(async (session) => {
            providerSessionId = session.sessionId;
            await enforceProviderSessionMode(
              ctx,
              session,
              launch.provider,
              options.permissionMode === "ask" ? "ask" : "readonly",
              emit,
            );
            await emit({
              type: "status",
              status: "running",
              title: "Agent 正在执行",
              details: { providerSessionId },
            });
            const turnController = new AbortController();
            const turnFailure = withTimeout(
              session.prompt(options.prompt, { cancellationSignal: turnController.signal }),
              options.turnTimeoutMs ?? ACP_TURN_TIMEOUT_MS,
              "Agent 运行",
              turnController,
            ).then(() => new Promise(() => {}));

            for (;;) {
              const message = await Promise.race([session.nextUpdate(), turnFailure]);
              if (message.kind === "stop") {
                return { stopReason: message.stopReason };
              }
              const event = eventFromUpdate(message.update);
              if (!event) continue;
              if (event.type === "message" && event.text) {
                const next = `${finalText}${event.text}`;
                if (Buffer.byteLength(next, "utf8") > ACP_MAX_FINAL_TEXT_BYTES) {
                  throw new AcpRunnerValidationError("Agent 输出超过 2 MiB 安全上限");
                }
                finalText = next;
              }
              await emit(event);
            }
          });
        }),
      abortWait.promise,
      processError.promise,
    ]);

    await emit({ type: "completed", status: "completed", title: "运行完成" });
    return {
      providerSessionId,
      protocolVersion: capabilities?.protocolVersion ?? null,
      capabilities,
      stopReason: result?.stopReason ?? "end_turn",
      finalText: stripProviderRuntimeNotices(launch.provider, finalText),
    };
  } catch (error) {
    if (cancelController.signal.aborted || options.signal?.aborted) {
      await emit({ type: "status", status: "cancelled", title: "运行已取消" });
      const cancelled = new Error("运行已取消", { cause: error });
      cancelled.name = "AbortError";
      throw cancelled;
    }
    await emit({ type: "error", status: "failed", title: "Agent 运行失败" });
    const safeError = new Error(
      error instanceof AcpRunnerTimeoutError
        ? error.message
        : error instanceof AcpRunnerUnavailableError
          ? error.message
        : classifyAcpFailure(launch.provider, stderr, error),
      { cause: error },
    );
    safeError.name = error?.name ?? "AcpRunnerError";
    throw safeError;
  } finally {
    abortWait.dispose();
    processError.dispose();
    options.signal?.removeEventListener("abort", callerAbort);
    if (processStillRunning(child)) {
      try { child.stdin?.end(); } catch { /* already closed */ }
      terminateProcessGroup(child, "SIGTERM");
      if (!(await waitForExit(child, 1_500))) terminateProcessGroup(child, "SIGKILL");
    }
  }
}
