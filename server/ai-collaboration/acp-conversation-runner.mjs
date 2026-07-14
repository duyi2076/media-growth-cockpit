import { spawn } from "node:child_process";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import {
  ACP_INITIALIZE_TIMEOUT_MS,
  ACP_MAX_FINAL_TEXT_BYTES,
  ACP_PERMISSION_TIMEOUT_MS,
  ACP_TURN_TIMEOUT_MS,
  AcpRunnerTimeoutError,
  AcpRunnerUnavailableError,
  AcpRunnerValidationError,
  classifyAcpFailure,
  stripProviderRuntimeNotices,
} from "./acp-runner.mjs";
import { redactAiLogValue, redactSensitiveString } from "./redaction.mjs";

const PROVIDER_IDS = new Set(["codex", "claude", "kimi", "gemini", "grok"]);
const MAX_EVENT_TEXT_BYTES = 48 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;

export class AcpConversationResumeUnsupportedError extends Error {
  constructor(message = "当前 Agent 不支持恢复长期会话，请关闭旧会话后新建") {
    super(message);
    this.name = "AcpConversationResumeUnsupportedError";
  }
}

function limitedText(value, maxBytes = MAX_EVENT_TEXT_BYTES) {
  const safe = redactSensitiveString(String(value ?? ""));
  const bytes = Buffer.from(safe, "utf8");
  return bytes.byteLength <= maxBytes ? safe : `${bytes.subarray(0, maxBytes).toString("utf8")}\n[内容已截断]`;
}

function utf8Chunks(value, maxBytes = MAX_EVENT_TEXT_BYTES) {
  const chunks = [];
  let current = "";
  let currentBytes = 0;
  for (const character of String(value)) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (current && currentBytes + bytes > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += bytes;
  }
  if (current) chunks.push(current);
  return chunks;
}

function safeStreamingCut(value) {
  const boundaries = [];
  const pattern = /[\s,;]+/g;
  let match;
  while ((match = pattern.exec(value)) !== null) boundaries.push(match.index + match[0].length);
  if (boundaries.length <= 4) {
    // Credential formats handled by redaction are ASCII. A short all-non-ASCII
    // fragment can be streamed immediately (important for Chinese UI/cancel
    // feedback) without becoming the prefix of a split credential.
    return /[A-Za-z0-9_=:/+.-]/.test(value) ? 0 : value.length;
  }
  let cut = boundaries[boundaries.length - 5];
  const privateKeyStart = value.lastIndexOf("-----BEGIN ");
  const privateKeyEnd = value.lastIndexOf("-----END ");
  if (privateKeyStart >= 0 && privateKeyStart > privateKeyEnd && privateKeyStart < cut) cut = privateKeyStart;
  return cut;
}

function safeDetails(value) {
  const safe = redactAiLogValue(value);
  return Buffer.byteLength(JSON.stringify(safe), "utf8") <= MAX_EVENT_TEXT_BYTES ? safe : { truncated: true };
}

function eventFromUpdate(update) {
  switch (update?.sessionUpdate) {
    case "agent_message_chunk":
      return update.content?.type === "text"
        ? { type: "message", text: limitedText(update.content.text) }
        : { type: "message", text: `[${update.content?.type ?? "content"}]` };
    case "agent_thought_chunk":
      return update.content?.type === "text"
        ? { type: "thought", text: limitedText(update.content.text) }
        : { type: "thought", text: "Agent 正在思考" };
    case "plan": return { type: "plan", title: "执行计划", details: safeDetails(update) };
    case "tool_call": return {
      type: "tool_call", toolCallId: String(update.toolCallId), title: limitedText(update.title ?? "工具调用", 2_048),
      status: update.status ?? "pending", details: safeDetails({ kind: update.kind, locations: update.locations }),
    };
    case "tool_call_update": return {
      type: "tool_update", toolCallId: String(update.toolCallId), title: limitedText(update.title ?? "工具调用更新", 2_048),
      status: update.status ?? "in_progress", details: safeDetails({ kind: update.kind, locations: update.locations, content: update.content }),
    };
    case "available_commands_update":
    case "current_mode_update":
    case "config_option_update":
      return { type: "status", title: "Agent 状态已更新", details: safeDetails(update) };
    default: return null;
  }
}

function normalizePermission(params) {
  return {
    toolCallId: String(params.toolCall?.toolCallId ?? "unknown"),
    title: limitedText(params.toolCall?.title ?? "敏感操作", 2_048),
    kind: params.toolCall?.kind ?? null,
    options: (params.options ?? [])
      .filter((option) => option.kind === "allow_once" || option.kind === "reject_once")
      .map((option) => ({ optionId: String(option.optionId), name: limitedText(option.name, 2_048), kind: option.kind })),
    details: safeDetails({ locations: params.toolCall?.locations }),
  };
}

function processStillRunning(child) {
  return child?.exitCode === null && child?.signalCode === null;
}

function terminateProcessGroup(child, signal = "SIGTERM") {
  if (!child?.pid || !processStillRunning(child)) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { try { child.kill(signal); } catch { /* already exited */ } }
}

function waitForExit(child, timeoutMs) {
  if (!processStillRunning(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
    timer.unref?.();
    const onExit = () => { cleanup(); resolve(true); };
    const cleanup = () => { clearTimeout(timer); child.removeListener("exit", onExit); };
    child.once("exit", onExit);
  });
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
  } finally { clearTimeout(timer); }
}

function nowIso(now) {
  const value = now?.() ?? new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new AcpRunnerValidationError("事件时间无效");
  return date.toISOString();
}

function capabilityAdvertised(value) {
  return value !== null && value !== undefined && (typeof value === "object" || value === true);
}

async function enforceMode(ctx, sessionResponse, provider, permissionMode) {
  const modeId = permissionMode === "readonly"
    ? { codex: "read-only", claude: "plan" }[provider]
    : { codex: "agent", claude: "default" }[provider];
  if (!modeId) return null;
  const modes = sessionResponse?.modes;
  if (!modes?.availableModes?.some((mode) => mode.id === modeId)) {
    throw new AcpRunnerUnavailableError(`${provider} 未提供所需的安全运行模式`);
  }
  if (modes.currentModeId !== modeId) {
    await ctx.request(acp.methods.agent.session.setMode, { sessionId: sessionResponse.sessionId, modeId });
  }
  return modeId;
}

function validateOptions(options) {
  const { launch, cwd } = options;
  if (!launch || !PROVIDER_IDS.has(launch.provider)) throw new AcpRunnerValidationError("无效启动配置");
  if (typeof launch.executable !== "string" || !path.isAbsolute(launch.executable) || launch.executable.includes("\0")) {
    throw new AcpRunnerValidationError("Agent 可执行文件必须是已验证绝对路径");
  }
  if (!Array.isArray(launch.args) || launch.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new AcpRunnerValidationError("Agent 参数无效");
  }
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) || cwd.includes("\0")) {
    throw new AcpRunnerValidationError("会话工作区必须是绝对路径");
  }
}

/**
 * One long-lived ACP client connection and one real provider session.
 * It intentionally uses only public SDK APIs: ClientApp.connect(), request(),
 * notify(), and onNotification(). A caller may prompt it many times, one at a
 * time. Browser reconnects never create a new provider process.
 */
export function createAcpConversationRunner(options) {
  validateOptions(options);
  const launch = options.launch;
  const permissionMode = options.permissionMode === "ask" ? "ask" : "readonly";
  const now = options.now ?? (() => new Date());
  let child = null;
  let connection = null;
  let ctx = null;
  let providerSessionId = null;
  let latestSession = options.savedSession ?? null;
  let capabilities = null;
  let continuityMode = null;
  let currentTurn = null;
  let connectPromise = null;
  let closed = false;
  let stderr = "";

  async function emit(event) {
    if (!currentTurn?.onEvent) return;
    await currentTurn.onEvent({ ...event, createdAt: nowIso(now) });
  }

  async function handlePermission(params) {
    const request = normalizePermission(params);
    const reject = request.options.find((option) => option.kind === "reject_once");
    if (!currentTurn || params.sessionId !== providerSessionId || permissionMode !== "ask") {
      return reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } };
    }
    if (!request.options.length || typeof currentTurn.requestPermission !== "function") {
      return { outcome: { outcome: "cancelled" } };
    }
    const permissionController = new AbortController();
    const selected = await withTimeout(
      Promise.resolve(currentTurn.requestPermission(request, permissionController.signal)),
      options.permissionTimeoutMs ?? ACP_PERMISSION_TIMEOUT_MS,
      "权限确认",
      permissionController,
    ).catch(() => null);
    const option = request.options.find((item) => item.optionId === selected?.optionId);
    return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
  }

  async function flushMessageBuffer(turn, { final = false } = {}) {
    if (turn.initialNoticePending) {
      const stripped = stripProviderRuntimeNotices(launch.provider, turn.pendingMessage);
      const knownNoticePrefix = turn.pendingMessage.startsWith("Warning: Skill descriptions were shortened");
      if (!final && knownNoticePrefix && stripped === turn.pendingMessage) return;
      turn.pendingMessage = stripped;
      turn.initialNoticePending = false;
    }
    const cut = final ? turn.pendingMessage.length : safeStreamingCut(turn.pendingMessage);
    if (cut <= 0) return;
    const rawPrefix = turn.pendingMessage.slice(0, cut);
    turn.pendingMessage = turn.pendingMessage.slice(cut);
    const safePrefix = redactSensitiveString(rawPrefix);
    turn.finalText += safePrefix;
    for (const text of utf8Chunks(safePrefix)) {
      turn.eventChain = turn.eventChain.then(() => emit({ type: "message", text }));
    }
    await turn.eventChain;
  }

  async function handleUpdate(params) {
    if (!currentTurn || params.sessionId !== providerSessionId) return;
    if (params.update?.sessionUpdate === "agent_message_chunk" && params.update.content?.type === "text") {
      const chunk = String(params.update.content.text);
      currentTurn.rawBytes += Buffer.byteLength(chunk, "utf8");
      if (currentTurn.rawBytes > ACP_MAX_FINAL_TEXT_BYTES) {
        currentTurn.outputError = new AcpRunnerValidationError("Agent 输出超过 2MiB 安全上限");
        await cancelCurrent();
        return;
      }
      currentTurn.pendingMessage += chunk;
      // Keep several unfinished lexical units as an overlap window. This
      // preserves live streaming while preventing credentials split across
      // provider chunks from being persisted as separate harmless fragments.
      await flushMessageBuffer(currentTurn);
      return;
    }
    const event = eventFromUpdate(params.update);
    if (!event) return;
    currentTurn.eventChain = currentTurn.eventChain.then(() => emit(event));
    await currentTurn.eventChain;
  }

  async function startConnection() {
    if (closed) throw new AcpRunnerUnavailableError("AI 会话已经关闭");
    if (connection && ctx && processStillRunning(child)) return;
    child = (options.spawnProcess ?? spawn)(launch.executable, [...launch.args], {
      cwd: options.cwd,
      env: { ...launch.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const launchedChild = child;
    launchedChild.once("exit", () => {
      if (child !== launchedChild) return;
      connection?.close(new AcpRunnerUnavailableError("Agent 进程已经退出"));
      connection = null;
      ctx = null;
      connectPromise = null;
    });
    stderr = "";
    child.stderr?.on("data", (chunk) => { stderr = limitedText(`${stderr}${chunk}`, MAX_STDERR_BYTES); });
    const processError = new Promise((_, reject) => {
      child.once("error", (error) => reject(new AcpRunnerUnavailableError("Agent 启动失败，请刷新状态后重试", { cause: error })));
    });
    const app = acp.client({ name: "media-growth-cockpit" })
      .onRequest(acp.methods.client.session.requestPermission, (requestContext) => handlePermission(requestContext.params))
      .onNotification(acp.methods.client.session.update, (updateContext) => handleUpdate(updateContext.params));
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    connection = app.connect(stream);
    ctx = connection.agent;

    try {
      const initController = new AbortController();
      const initialized = await Promise.race([
        withTimeout(ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        }, { cancellationSignal: initController.signal }), options.initializeTimeoutMs ?? ACP_INITIALIZE_TIMEOUT_MS, "ACP 初始化", initController),
        processError,
      ]);
      capabilities = redactAiLogValue({
        protocolVersion: initialized.protocolVersion,
        agentCapabilities: initialized.agentCapabilities,
        authMethods: initialized.authMethods?.map((method) => ({ id: method.id, name: method.name })) ?? [],
      });
      const saved = latestSession;
      let sessionResponse;
      if (saved?.providerSessionId) {
        if (!capabilityAdvertised(initialized.agentCapabilities?.sessionCapabilities?.resume)) {
          throw new AcpConversationResumeUnsupportedError();
        }
        sessionResponse = await ctx.request(acp.methods.agent.session.resume, {
          sessionId: saved.providerSessionId,
          cwd: options.cwd,
          mcpServers: [],
        });
        providerSessionId = saved.providerSessionId;
        continuityMode = "resumed";
      } else {
        sessionResponse = await ctx.request(acp.methods.agent.session.new, { cwd: options.cwd, mcpServers: [] });
        providerSessionId = sessionResponse.sessionId;
        continuityMode = "live";
      }
      const modeId = await enforceMode(ctx, { ...sessionResponse, sessionId: providerSessionId }, launch.provider, permissionMode);
      latestSession = {
        providerSessionId,
        protocolVersion: initialized.protocolVersion ?? null,
        capabilities,
        continuityMode,
        modeId,
        lastAttachedAt: nowIso(now),
      };
      await options.onSession?.(latestSession);
    } catch (error) {
      await shutdownProcess(false);
      if (error instanceof AcpConversationResumeUnsupportedError || error instanceof AcpRunnerUnavailableError || error instanceof AcpRunnerTimeoutError) throw error;
      throw new AcpRunnerUnavailableError(classifyAcpFailure(launch.provider, stderr, error), { cause: error });
    }
  }

  async function ensureConnected(reconnectAttempt = 0) {
    if (connectPromise && (!connection || connection.signal.aborted || !processStillRunning(child))) {
      connectPromise = null;
      connection = null;
      ctx = null;
    }
    if (!connectPromise) connectPromise = startConnection().catch((error) => { connectPromise = null; throw error; });
    await connectPromise;
    if (!connection || connection.signal.aborted || !processStillRunning(child)) {
      connectPromise = null;
      if (reconnectAttempt >= 1) {
        await shutdownProcess(false);
        throw new AcpRunnerUnavailableError("Agent 建立会话后立即退出，请检查 CLI 状态");
      }
      return ensureConnected(reconnectAttempt + 1);
    }
  }

  async function notifySessionCancel() {
    if (ctx && providerSessionId) {
      const cancelController = new AbortController();
      await withTimeout(
        ctx.notify(acp.methods.agent.session.cancel, { sessionId: providerSessionId }),
        options.cancelNotifyTimeoutMs ?? 500,
        "取消 Agent 会话",
        cancelController,
      ).catch(() => {});
    }
  }

  async function cancelCurrent() {
    if (!currentTurn) return;
    currentTurn.cancelled = true;
    currentTurn.controller.abort(new DOMException("Cancelled", "AbortError"));
    await notifySessionCancel();
  }

  async function prompt(input) {
    if (typeof input?.text !== "string" || !input.text.trim()) throw new AcpRunnerValidationError("消息不能为空");
    if (currentTurn) throw new AcpRunnerValidationError("当前会话已有正在执行的 turn");
    await ensureConnected();
    const controller = new AbortController();
    const turn = {
      controller, onEvent: input.onEvent, requestPermission: input.requestPermission,
      pendingMessage: "", finalText: "", rawBytes: 0, initialNoticePending: true,
      eventChain: Promise.resolve(), outputError: null, cancelled: false,
    };
    currentTurn = turn;
    const abort = () => { void cancelCurrent(); };
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener("abort", abort, { once: true });
    try {
      await emit({ type: "status", status: continuityMode === "resumed" ? "resumed" : "running", title: "Agent 正在回复" });
      const response = await withTimeout(ctx.request(acp.methods.agent.session.prompt, {
        sessionId: providerSessionId,
        prompt: [{ type: "text", text: input.text }],
      }, { cancellationSignal: controller.signal }), options.turnTimeoutMs ?? ACP_TURN_TIMEOUT_MS, "Agent 运行", controller);
      await turn.eventChain;
      if (turn.outputError) throw turn.outputError;
      if (turn.cancelled || input.signal?.aborted || response.stopReason === "cancelled") {
        await flushMessageBuffer(turn, { final: true });
        const error = new Error("运行已取消");
        error.name = "AbortError";
        error.partialText = turn.finalText;
        throw error;
      }
      await flushMessageBuffer(turn, { final: true });
      const finalText = turn.finalText;
      return {
        protocolVersion: capabilities?.protocolVersion ?? null,
        capabilities,
        continuityMode,
        stopReason: response.stopReason ?? "end_turn",
        finalText,
      };
    } catch (error) {
      if (error instanceof AcpRunnerTimeoutError) {
        await notifySessionCancel();
        // A timed-out JSON-RPC request may still be running inside the Agent.
        // Reclaim the process before allowing another turn to resume the session.
        await shutdownProcess(false);
        throw error;
      }
      if (turn.cancelled || input.signal?.aborted || error?.name === "AbortError") {
        await flushMessageBuffer(turn, { final: true });
        const cancelled = new Error("运行已取消", { cause: error });
        cancelled.name = "AbortError";
        cancelled.partialText = turn.finalText;
        throw cancelled;
      }
      if (error instanceof AcpRunnerValidationError) throw error;
      throw new Error(classifyAcpFailure(launch.provider, stderr, error), { cause: error });
    } finally {
      input.signal?.removeEventListener("abort", abort);
      if (currentTurn === turn) currentTurn = null;
    }
  }

  async function shutdownProcess(closeSession = true) {
    const active = currentTurn;
    if (active) await cancelCurrent();
    if (closeSession && ctx && providerSessionId && capabilityAdvertised(capabilities?.agentCapabilities?.sessionCapabilities?.close)) {
      const closeController = new AbortController();
      await withTimeout(
        ctx.request(
          acp.methods.agent.session.close,
          { sessionId: providerSessionId },
          { cancellationSignal: closeController.signal },
        ),
        options.closeTimeoutMs ?? 1_000,
        "关闭 Agent 会话",
        closeController,
      ).catch(() => {});
    }
    connection?.close();
    connection = null;
    ctx = null;
    connectPromise = null;
    try { child?.stdin?.end(); } catch { /* already closed */ }
    if (processStillRunning(child)) {
      terminateProcessGroup(child, "SIGTERM");
      if (!(await waitForExit(child, 1_500))) terminateProcessGroup(child, "SIGKILL");
      await waitForExit(child, 500);
    }
    child = null;
    if (active && currentTurn === active) currentTurn = null;
  }

  async function close() {
    if (closed) return;
    closed = true;
    await shutdownProcess(true);
  }

  async function suspend() {
    if (closed) return;
    closed = true;
    await shutdownProcess(false);
  }

  return {
    prompt,
    cancel: cancelCurrent,
    close,
    suspend,
    get connected() { return Boolean(connection && ctx && processStillRunning(child)); },
  };
}
