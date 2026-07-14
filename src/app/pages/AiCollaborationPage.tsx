import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import {
  ArrowClockwise,
  Check,
  CheckCircle,
  ClockCounterClockwise,
  FileText,
  GearSix,
  PaperPlaneTilt,
  Plus,
  Stop,
  WarningCircle,
  X,
} from "phosphor-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { DetailDrawer } from "@/components/ui/DetailDrawer";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  getAiAgents,
  getAiEnvironmentJob,
  isAiAgentRunnable,
  startAiEnvironmentAction,
  type AiAgentCatalogItem,
  type AiAgentId,
  type AiContextKind,
  type AiEnvironmentAction,
  type AiEnvironmentJob,
  type AiPermissionMode,
  type AiRunEvent,
} from "@/data/aiCollaborationClient";
import {
  acceptAiConversationTurn,
  AiConversationConflictError,
  AiConversationsApiError,
  cancelAiConversationTurn,
  closeAiConversation,
  createAiConversation,
  createAiConversationTurn,
  getAiConversation,
  getAiConversations,
  importAiConversation,
  isAiConversationTurnActive,
  respondAiConversationPermission,
  subscribeToAiConversation,
  type AiConversation,
  type AiConversationTurn,
} from "@/data/aiConversationsClient";
import { useWorkbenchIndex } from "@/data/adapter";
import {
  DailyTasksApiError,
  DailyTasksConflictError,
  getDailyTasks,
  putDailyTasks,
  type DailyTasksSnapshot,
} from "@/data/dailyTasksClient";
import { getDailyReviews, type DailyReviewSnapshot } from "@/data/dailyReviewsClient";
import { openInObsidian } from "@/data/openObsidianClient";
import { getReviewAssets, type ReviewAssetSnapshot } from "@/data/reviewAssetsClient";
import { useVaultSync } from "@/hooks/useVaultSync";
import type { ContentItem, TodayTask } from "@/types";

const CONTEXT_KINDS: Array<{ value: AiContextKind; label: string }> = [
  { value: "topic", label: "选题" },
  { value: "content", label: "内容" },
  { value: "content-review", label: "内容复盘" },
  { value: "account-breakdown", label: "账号拆解" },
  { value: "daily-review", label: "每日复盘" },
];

const TURN_STATUS_LABEL: Record<AiConversationTurn["status"], string> = {
  queued: "等待回复",
  running: "正在回复",
  waiting_permission: "需要确认",
  completed: "已完成",
  failed: "回复失败",
  cancelled: "已停止",
};

interface ContextOption {
  type: AiContextKind;
  id: string;
  title: string;
  summary?: string;
}

function isAiContextKind(value: TodayTask["linkType"]): value is AiContextKind {
  return value !== null && ["topic", "content", "content-review", "account-breakdown", "daily-review"].includes(value);
}

function apiMessage(error: unknown, fallback = "AI 协作暂时不可用"): string {
  if (error instanceof AiConversationsApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function buildContextOptions(
  kind: AiContextKind,
  contents: ContentItem[],
  reviews: ReviewAssetSnapshot[],
  dailyReviews: DailyReviewSnapshot[],
): ContextOption[] {
  if (kind === "topic") {
    return contents
      .filter((item) => ["候选选题", "已立项"].includes(item.status))
      .map((item) => ({ type: kind, id: item.id, title: item.title, summary: item.summary }));
  }
  if (kind === "content") {
    return contents
      .filter((item) => item.status !== "已归档")
      .map((item) => ({ type: kind, id: item.id, title: item.title, summary: item.summary }));
  }
  if (kind === "daily-review") {
    return dailyReviews.map((item) => ({
      type: kind,
      id: item.id,
      title: `${item.date} 每日复盘`,
      summary: item.judgment || item.tomorrowAction,
    }));
  }
  const reviewKind = kind === "content-review" ? "content-review" : "account-breakdown";
  return reviews
    .filter((item) => item.kind === reviewKind)
    .map((item) => ({ type: kind, id: item.id, title: item.title, summary: item.summary }));
}

function upsertConversation(list: AiConversation[], next: AiConversation): AiConversation[] {
  return [next, ...list.filter((item) => item.id !== next.id)]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function conversationEventCount(conversation: AiConversation): number {
  return conversation.turns.reduce((total, turn) => total + turn.events.length, 0);
}

function preferConversationSnapshot(current: AiConversation, next: AiConversation): AiConversation {
  if (current.id !== next.id) return current;
  if (next.revision !== current.revision) return next.revision > current.revision ? next : current;
  const currentEvents = conversationEventCount(current);
  const nextEvents = conversationEventCount(next);
  if (nextEvents !== currentEvents) return nextEvents > currentEvents ? next : current;
  return next.updatedAt >= current.updatedAt ? next : current;
}

function conversationMatchesDailyTask(conversation: AiConversation, taskId: string, date: string): boolean {
  return conversation.sourceTask?.id === taskId && conversation.sourceTask.date === date;
}

function providerName(agents: AiAgentCatalogItem[], provider: AiAgentId): string {
  const historical: Partial<Record<AiAgentId, string>> = { gemini: "旧 Gemini CLI", antigravity: "Antigravity" };
  return agents.find((agent) => agent.id === provider)?.displayName ?? historical[provider] ?? provider;
}

function environmentActionFor(agent: AiAgentCatalogItem): AiEnvironmentAction | null {
  if ((!agent.installed || agent.status === "missing") && agent.actions.canInstall) return "install";
  if (agent.authStatus === "login_required" && agent.actions.canLogin) return "login";
  if (agent.versionStatus === "outdated" && agent.actions.canUpdate) return "update";
  return null;
}

function environmentStatus(agent: AiAgentCatalogItem): string {
  if (!agent.installed || agent.status === "missing") return "未安装";
  if (agent.authStatus === "login_required") return "需要登录";
  if (agent.status === "adapter_required") return "连接组件缺失";
  if (agent.status === "timeout") return "检测超时";
  if (agent.status === "incompatible") return "当前版本不兼容";
  if (agent.status === "error") return "检测失败";
  if (agent.versionStatus === "outdated") return "有新版本";
  return "已可使用";
}

function environmentActionLabel(action: AiEnvironmentAction): string {
  if (action === "install") return "安装";
  if (action === "update") return "更新";
  return "登录";
}

function contextKindLabel(kind: AiContextKind): string {
  return CONTEXT_KINDS.find((item) => item.value === kind)?.label ?? "资料";
}

function readableDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function safeVisibleText(value: string): string {
  return value
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s"'<>]+[\\/])+[^\s"'<>]*/g, "本地文件")
    .replace(/\b[a-f0-9]{32,128}\b/gi, "版本标识")
    .trim();
}

function safePermissionScope(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function eventLabel(event: AiRunEvent): string {
  if (event.type === "thought") return "思考";
  if (event.type === "plan") return "计划";
  if (event.type === "tool_call" || event.type === "tool_update") return "资料处理";
  if (event.type === "diff") return "修改";
  return "进度";
}

function eventSummary(event: AiRunEvent): string {
  if (event.type === "tool_call" || event.type === "tool_update") return "已处理一项相关资料";
  if (event.type === "diff") return "已形成一处修改";
  const value = safeVisibleText(event.title || event.text || "");
  return value || "已更新";
}

function createRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `message-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function AssistantMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ href, children }) => {
          if (!href || !/^https?:\/\//i.test(href)) return <span>{children}</span>;
          return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
        },
        img: ({ alt }) => alt ? <span className="ai-markdown-image-label">图片：{alt}</span> : null,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

export function AiCollaborationPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const taskId = searchParams.get("taskId")?.trim() || null;
  const requestedConversationId = searchParams.get("conversationId")?.trim() || null;
  const { data } = useWorkbenchIndex();

  const [agents, setAgents] = useState<AiAgentCatalogItem[]>([]);
  const [conversations, setConversations] = useState<AiConversation[]>([]);
  const [activeConversation, setActiveConversation] = useState<AiConversation | null>(null);
  const [reviews, setReviews] = useState<ReviewAssetSnapshot[]>([]);
  const [dailyReviews, setDailyReviews] = useState<DailyReviewSnapshot[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<AiAgentId | null>(null);
  const [contextKind, setContextKind] = useState<AiContextKind>("topic");
  const [contextId, setContextId] = useState("");
  const [permissionMode, setPermissionMode] = useState<AiPermissionMode>("readonly");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [contextPickerOpen, setContextPickerOpen] = useState(false);
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [environmentJob, setEnvironmentJob] = useState<AiEnvironmentJob | null>(null);
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [agentLoading, setAgentLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [closing, setClosing] = useState(false);
  const [acceptingTurnId, setAcceptingTurnId] = useState<string | null>(null);
  const [respondingPermissionId, setRespondingPermissionId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [openingObsidian, setOpeningObsidian] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [reviewContextError, setReviewContextError] = useState(false);
  const [dailyContextError, setDailyContextError] = useState(false);
  const [sourceSnapshot, setSourceSnapshot] = useState<DailyTasksSnapshot | null>(null);
  const [sourceTaskLoading, setSourceTaskLoading] = useState(false);
  const [sourceTaskSaving, setSourceTaskSaving] = useState(false);
  const [sourceTaskError, setSourceTaskError] = useState<string | null>(null);
  const [restoringConversation, setRestoringConversation] = useState(Boolean(requestedConversationId));

  const composing = useRef(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const permissionFirstActionRef = useRef<HTMLButtonElement>(null);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const environmentButtonRef = useRef<HTMLButtonElement>(null);
  const draftRequestIds = useRef<Record<string, { id: string; fingerprint: string }>>({});

  const newDraftKey = `__new__:${taskId ?? "free"}:${selectedAgentId ?? "pending"}`;
  const draftKey = activeConversation?.id ?? newDraftKey;
  const draft = drafts[draftKey] ?? "";
  const setDraft = useCallback((value: string) => {
    delete draftRequestIds.current[draftKey];
    setDrafts((current) => ({ ...current, [draftKey]: value }));
  }, [draftKey]);

  const clearSentDraft = useCallback((key: string, message: string, requestId: string) => {
    setDrafts((current) => {
      if ((current[key] ?? "").trim() !== message) return current;
      return { ...current, [key]: "" };
    });
    if (draftRequestIds.current[key]?.id === requestId) delete draftRequestIds.current[key];
  }, []);

  const applyConversationSnapshot = useCallback((next: AiConversation) => {
    setActiveConversation((current) => (
      current && current.id === next.id ? preferConversationSnapshot(current, next) : next
    ));
  }, []);

  const handleConversationMutationError = useCallback((error: unknown, fallback: string) => {
    if (error instanceof AiConversationConflictError) {
      if (error.snapshot) {
        applyConversationSnapshot(error.snapshot);
        setConversationError("会话已在其他页面更新，已载入最新状态。请核对后重试。");
      } else {
        setConversationError("会话已发生变化，但最新状态暂时无法载入。请刷新后重试。");
      }
      return;
    }
    setConversationError(apiMessage(error, fallback));
  }, [applyConversationSnapshot]);

  const loadAgents = useCallback(async (refresh = false) => {
    setAgentLoading(true);
    setAgentError(null);
    try {
      const result = await getAiAgents(undefined, { refresh });
      setAgents(result.agents);
      setSelectedAgentId((current) => {
        if (current && result.agents.some((agent) => agent.id === current && isAiAgentRunnable(agent))) return current;
        return result.agents.find(isAiAgentRunnable)?.id ?? null;
      });
    } catch (error) {
      setAgentError(apiMessage(error, "无法读取可用 AI"));
    } finally {
      setAgentLoading(false);
    }
  }, []);

  const loadConversations = useCallback(async () => {
    try {
      setConversations(await getAiConversations());
    } catch (error) {
      setConversationError(apiMessage(error, "会话记录暂时无法读取"));
    }
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.all([loadAgents(), loadConversations()]).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [loadAgents, loadConversations]);

  useEffect(() => {
    if (!requestedConversationId || activeConversation?.id === requestedConversationId) {
      setRestoringConversation(false);
      return;
    }
    const controller = new AbortController();
    setRestoringConversation(true);
    setConversationError(null);
    void getAiConversation(requestedConversationId, controller.signal)
      .then(applyConversationSnapshot)
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setConversationError(apiMessage(error, "这次会话暂时无法打开"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setRestoringConversation(false);
      });
    return () => controller.abort();
  }, [activeConversation?.id, applyConversationSnapshot, requestedConversationId]);

  useEffect(() => {
    if (!taskId) {
      setSourceSnapshot(null);
      setSourceTaskError(null);
      return;
    }
    const controller = new AbortController();
    setSourceTaskLoading(true);
    setSourceTaskError(null);
    void getDailyTasks(controller.signal)
      .then((snapshot) => {
        setSourceSnapshot(snapshot);
        if (!snapshot.tasks.some((task) => task.id === taskId)) {
          setSourceTaskError("今天的任务中找不到这项任务，请返回增长总览重新选择");
        }
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setSourceTaskError(error instanceof DailyTasksApiError ? error.message : "来源任务暂时无法读取");
      })
      .finally(() => {
        if (!controller.signal.aborted) setSourceTaskLoading(false);
      });
    return () => controller.abort();
  }, [taskId]);

  const loadContextSources = useCallback(async (signal?: AbortSignal) => {
    setReviewContextError(false);
    setDailyContextError(false);
    const [reviewResult, dailyResult] = await Promise.allSettled([
      getReviewAssets(signal),
      getDailyReviews(signal),
    ]);
    if (signal?.aborted) return;
    if (reviewResult.status === "fulfilled") setReviews(reviewResult.value.items);
    else setReviewContextError(true);
    if (dailyResult.status === "fulfilled") setDailyReviews(dailyResult.value.items);
    else setDailyContextError(true);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadContextSources(controller.signal);
    return () => controller.abort();
  }, [loadContextSources]);
  useVaultSync(["review-assets", "daily-reviews"], loadContextSources);

  const sourceTask = taskId ? sourceSnapshot?.tasks.find((task) => task.id === taskId) ?? null : null;
  const sourceTaskIsProjectTask = sourceTask?.linkType === "task";
  const sourceTaskHasContext = Boolean(sourceTask && isAiContextKind(sourceTask.linkType) && sourceTask.linkId);
  const sourceTaskBlocksConversation = Boolean(
    taskId
    && (sourceTaskLoading || !sourceSnapshot || !sourceTask || sourceTaskIsProjectTask || sourceTaskError),
  );
  const contextOptions = useMemo(
    () => buildContextOptions(contextKind, data?.contents ?? [], reviews, dailyReviews),
    [contextKind, dailyReviews, data?.contents, reviews],
  );
  const selectedContext = contextOptions.find((item) => item.id === contextId) ?? null;
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? null;
  const selectedAgentSupportsAsk = Boolean(selectedAgent && !["kimi", "antigravity", "grok"].includes(selectedAgent.id));
  const currentContext = activeConversation ? activeConversation.context : selectedContext;
  const contextLoadError = contextKind === "daily-review"
    ? dailyContextError
    : ["content-review", "account-breakdown"].includes(contextKind) && reviewContextError;
  const visibleConversations = useMemo(() => {
    if (!taskId) return conversations;
    if (!sourceSnapshot?.date) return [];
    return conversations.filter((conversation) => conversationMatchesDailyTask(conversation, taskId, sourceSnapshot.date));
  }, [conversations, sourceSnapshot?.date, taskId]);

  useEffect(() => {
    if (!sourceTask || !isAiContextKind(sourceTask.linkType) || !sourceTask.linkId || activeConversation) return;
    setContextKind(sourceTask.linkType);
    setContextId(sourceTask.linkId);
  }, [activeConversation, sourceTask?.id, sourceTask?.linkId, sourceTask?.linkType]);

  useEffect(() => {
    if (!selectedAgentSupportsAsk && permissionMode === "ask") setPermissionMode("readonly");
  }, [permissionMode, selectedAgentSupportsAsk]);

  useEffect(() => {
    if (taskId && permissionMode !== "readonly") setPermissionMode("readonly");
  }, [permissionMode, taskId]);

  useEffect(() => {
    if (!activeConversation) return;
    setConversations((current) => upsertConversation(current, activeConversation));
  }, [activeConversation]);

  const activeTurn = activeConversation?.turns.find((turn) => turn.id === activeConversation.activeTurnId) ?? null;
  const activeTurnIsRunning = isAiConversationTurnActive(activeTurn);
  const completedTurns = useMemo(
    () => activeConversation?.turns.filter((turn) => turn.status === "completed" && turn.assistantText.trim() && turn.outputSha256) ?? [],
    [activeConversation?.turns],
  );
  const acceptedTurn = activeConversation?.turns.find((turn) => turn.id === activeConversation.acceptedTurnId) ?? null;

  useEffect(() => {
    if (!activeConversation || !activeTurnIsRunning) return;
    let subscription: { close: () => void } | null = null;
    try {
      subscription = subscribeToAiConversation(activeConversation.id, {
        onConversation: (next) => {
          setActiveConversation((current) => current ? preferConversationSnapshot(current, next) : next);
          setConversationError(null);
        },
        onError: () => setConversationError("实时连接暂时中断，正在重新连接"),
      });
    } catch {
      setConversationError("实时连接暂时中断，请稍后重试");
    }
    return () => subscription?.close();
  }, [activeConversation?.id, activeTurnIsRunning]);

  useEffect(() => {
    if (!activeConversation?.pendingPermission) return;
    const timer = window.setTimeout(() => permissionFirstActionRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [activeConversation?.pendingPermission?.id]);

  useLayoutEffect(() => {
    const node = messagesRef.current;
    if (!node || !followLatest.current) return;
    node.scrollTop = node.scrollHeight;
  }, [activeConversation?.turns]);

  const updateConversationParam = (id: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set("conversationId", id);
    else next.delete("conversationId");
    setSearchParams(next, { replace: true });
  };

  const saveSourceTaskLink = async (): Promise<boolean> => {
    if (!sourceSnapshot || !sourceTask || sourceTaskIsProjectTask || !selectedContext || sourceTaskSaving) return false;
    setSourceTaskSaving(true);
    setSourceTaskError(null);
    try {
      const saved = await putDailyTasks(
        sourceSnapshot.tasks.map((task) => task.id === sourceTask.id
          ? { ...task, linkType: selectedContext.type, linkId: selectedContext.id }
          : task),
        sourceSnapshot.hash,
      );
      setSourceSnapshot(saved);
      setContextPickerOpen(false);
      return true;
    } catch (error) {
      if (error instanceof DailyTasksConflictError) {
        setSourceSnapshot(error.snapshot);
        setSourceTaskError("Obsidian 中的任务已经变化，请核对最新任务后重新关联");
      } else {
        setSourceTaskError(error instanceof DailyTasksApiError ? error.message : "任务资料关联失败");
      }
      return false;
    } finally {
      setSourceTaskSaving(false);
    }
  };

  const sendMessage = async () => {
    const message = draft.trim();
    if (
      !message
      || sending
      || starting
      || restoringConversation
      || sourceTaskBlocksConversation
      || activeTurnIsRunning
      || activeConversation?.pendingPermission
    ) return;
    const requestFingerprint = activeConversation
      ? JSON.stringify({ conversationId: activeConversation.id, message })
      : JSON.stringify({
        provider: selectedAgent?.id ?? null,
        context: currentContext ? { type: currentContext.type, id: currentContext.id } : null,
        permissionMode,
        sourceTaskId: sourceTask && sourceTaskHasContext ? sourceTask.id : null,
        message,
      });
    const previousRequest = draftRequestIds.current[draftKey];
    const requestId = previousRequest?.fingerprint === requestFingerprint
      ? previousRequest.id
      : createRequestId();
    draftRequestIds.current[draftKey] = { id: requestId, fingerprint: requestFingerprint };
    if (activeConversation) {
      if (activeConversation.status === "closed") return;
      setSending(true);
      setConversationError(null);
      followLatest.current = true;
      try {
        const next = await createAiConversationTurn(activeConversation.id, {
          message,
          clientRequestId: requestId,
          expectedRevision: activeConversation.revision,
        });
        applyConversationSnapshot(next);
        clearSentDraft(draftKey, message, requestId);
      } catch (error) {
        handleConversationMutationError(error, "消息尚未发送");
      } finally {
        setSending(false);
      }
      return;
    }

    if (!selectedAgent || !isAiAgentRunnable(selectedAgent)) return;
    setStarting(true);
    setConversationError(null);
    followLatest.current = true;
    try {
      const created = await createAiConversation({
        provider: selectedAgent.id,
        templateId: "collaborate",
        clientRequestId: requestId,
        ...(currentContext ? { context: { type: currentContext.type, id: currentContext.id } } : {}),
        permissionMode,
        message,
        ...(sourceTask && sourceTaskHasContext ? { sourceTaskId: sourceTask.id } : {}),
      });
      applyConversationSnapshot(created);
      setConversations((current) => upsertConversation(current, created));
      clearSentDraft(draftKey, message, requestId);
      setContextPickerOpen(false);
      updateConversationParam(created.id);
    } catch (error) {
      setConversationError(apiMessage(error, "会话尚未开始"));
    } finally {
      setStarting(false);
    }
  };

  const cancelTurn = async () => {
    if (!activeConversation || !activeTurn || !activeTurnIsRunning || cancelling) return;
    setCancelling(true);
    setConversationError(null);
    try {
      applyConversationSnapshot(await cancelAiConversationTurn(activeConversation.id, activeTurn.id));
    } catch (error) {
      handleConversationMutationError(error, "当前回复尚未停止");
    } finally {
      setCancelling(false);
    }
  };

  const respondPermission = async (optionId: string) => {
    const permission = activeConversation?.pendingPermission;
    if (!activeConversation || !permission || respondingPermissionId) return;
    const turnId = permission.turnId || activeConversation.activeTurnId;
    if (!turnId) return;
    setRespondingPermissionId(permission.id);
    setConversationError(null);
    try {
      applyConversationSnapshot(await respondAiConversationPermission(activeConversation.id, turnId, permission.id, optionId));
    } catch (error) {
      handleConversationMutationError(error, "权限决定尚未提交");
    } finally {
      setRespondingPermissionId(null);
    }
  };

  const acceptTurn = async (turn: AiConversationTurn) => {
    if (!activeConversation || !turn.outputSha256 || acceptingTurnId) return;
    setAcceptingTurnId(turn.id);
    setConversationError(null);
    try {
      const next = await acceptAiConversationTurn(activeConversation.id, {
        turnId: turn.id,
        outputSha256: turn.outputSha256,
        expectedRevision: activeConversation.revision,
      });
      applyConversationSnapshot(next);
    } catch (error) {
      handleConversationMutationError(error, "最终版本尚未采用");
    } finally {
      setAcceptingTurnId(null);
    }
  };

  const importAcceptedTurn = async () => {
    if (!activeConversation || !acceptedTurn || activeConversation.importedTurnId === acceptedTurn.id || importing) return;
    if (!window.confirm("确认将已采用的最终成果保存到 Obsidian 吗？")) return;
    setImporting(true);
    setConversationError(null);
    try {
      applyConversationSnapshot(await importAiConversation(activeConversation.id));
    } catch (error) {
      handleConversationMutationError(error, "最终成果尚未保存");
    } finally {
      setImporting(false);
    }
  };

  const closeConversation = async () => {
    if (!activeConversation || activeConversation.status === "closed" || closing || activeTurnIsRunning) return;
    if (!window.confirm("确认结束这次会话吗？结束后仍可查看，但不能继续发送。")) return;
    setClosing(true);
    setConversationError(null);
    try {
      applyConversationSnapshot(await closeAiConversation(activeConversation.id));
    } catch (error) {
      handleConversationMutationError(error, "会话尚未结束");
    } finally {
      setClosing(false);
    }
  };

  const openImportedResult = async () => {
    if (!activeConversation?.importedRelativePath || openingObsidian) return;
    setOpeningObsidian(true);
    setConversationError(null);
    try {
      await openInObsidian(activeConversation.importedRelativePath);
    } catch (error) {
      setConversationError(apiMessage(error, "暂时无法打开 Obsidian"));
    } finally {
      setOpeningObsidian(false);
    }
  };

  const openConversation = async (conversation: AiConversation) => {
    setHistoryOpen(false);
    setConversationError(null);
    updateConversationParam(conversation.id);
    try {
      applyConversationSnapshot(await getAiConversation(conversation.id));
    } catch (error) {
      setConversationError(apiMessage(error, "这次会话暂时无法打开"));
    }
  };

  const newConversation = () => {
    setActiveConversation(null);
    setContextId("");
    setContextPickerOpen(false);
    setConversationError(null);
    updateConversationParam(null);
  };

  const runEnvironmentAction = async (agent: AiAgentCatalogItem, action: AiEnvironmentAction) => {
    if (activeConversation?.provider === agent.id && activeConversation.status !== "closed") {
      setEnvironmentError("这个 AI 正在当前会话中，请先结束会话再安装或更新。");
      return;
    }
    const verb = environmentActionLabel(action);
    if (!window.confirm(`确认${verb} ${agent.displayName} 吗？驾驶舱只会执行该产品的官方固定流程。`)) return;
    setEnvironmentError(null);
    try {
      let job = await startAiEnvironmentAction(agent.id, action);
      setEnvironmentJob(job);
      while (["queued", "running"].includes(job.status)) {
        await new Promise((resolve) => window.setTimeout(resolve, 700));
        job = await getAiEnvironmentJob(job.id);
        setEnvironmentJob(job);
      }
      if (job.status === "completed") await loadAgents(true);
      if (job.status === "failed") setEnvironmentError(job.message);
    } catch (error) {
      setEnvironmentError(apiMessage(error, `${verb}没有完成`));
    }
  };

  const agentUnavailableForNewConversation = !activeConversation && (agentLoading || !selectedAgent || !isAiAgentRunnable(selectedAgent));
  const inputDisabled = Boolean(
    activeConversation?.status === "closed"
    || activeConversation?.pendingPermission
    || restoringConversation
    || sourceTaskBlocksConversation
    || agentUnavailableForNewConversation,
  );
  let inputDisabledPlaceholder: string | null = null;
  if (restoringConversation) inputDisabledPlaceholder = "正在恢复会话…";
  else if (sourceTaskLoading || (taskId && !sourceSnapshot)) inputDisabledPlaceholder = "正在读取任务…";
  else if (sourceTaskError || sourceTaskIsProjectTask) inputDisabledPlaceholder = "请先处理上方的任务提示";
  else if (agentUnavailableForNewConversation) inputDisabledPlaceholder = "正在连接本机 AI…";
  else if (activeConversation?.status === "closed") inputDisabledPlaceholder = "这次会话已结束，可新建会话继续";
  else if (activeConversation?.pendingPermission) inputDisabledPlaceholder = "先完成上方确认";
  const sendBlocked = Boolean(
    !draft.trim()
    || sending
    || starting
    || restoringConversation
    || sourceTaskBlocksConversation
    || activeTurnIsRunning
    || inputDisabled
    || (!activeConversation && (!selectedAgent || !isAiAgentRunnable(selectedAgent))),
  );

  return (
    <div className="ai-conversation-page" data-layout="conversation">
      <header className="ai-conversation-page-header">
        <div className="ai-conversation-title-block">
          <h1>AI 工作台</h1>
          {activeConversation ? (
            <span>{providerName(agents, activeConversation.provider)}</span>
          ) : (
            <label className="ai-provider-select">
              <span>AI</span>
              <select
                aria-label="选择 AI"
                value={selectedAgentId ?? ""}
                disabled={agentLoading || agents.every((agent) => !isAiAgentRunnable(agent))}
                onChange={(event) => setSelectedAgentId(event.target.value as AiAgentId)}
              >
                {agentLoading ? <option value="">正在检测…</option> : null}
                {agents.filter(isAiAgentRunnable).map((agent) => <option value={agent.id} key={agent.id}>{agent.displayName}</option>)}
              </select>
              <button type="button" aria-label="刷新 AI 状态" onClick={() => void loadAgents(true)} disabled={agentLoading}>
                <ArrowClockwise size={14} />
              </button>
            </label>
          )}
          {currentContext ? (
            <div className="ai-header-context-group">
              <button
                type="button"
                className="ai-header-context-chip"
                disabled={Boolean(activeConversation || sourceTaskHasContext)}
                onClick={() => setContextPickerOpen(true)}
              >
                <FileText size={14} />
                <span>{contextKindLabel(currentContext.type)}</span>
                <strong>{currentContext.title}</strong>
              </button>
              {!activeConversation && !sourceTaskHasContext ? (
                <button type="button" className="ai-header-context-remove" aria-label="移除资料" onClick={() => setContextId("")}><X size={13} /></button>
              ) : null}
            </div>
          ) : (
            <button
              type="button"
              className="ai-header-add-context"
              disabled={Boolean(activeConversation || sourceTaskLoading || sourceTaskIsProjectTask)}
              onClick={() => setContextPickerOpen(true)}
            >
              <Plus size={14} />资料
            </button>
          )}
          {!activeConversation ? (
            <select
              className="ai-header-permission-select"
              aria-label="权限"
              value={permissionMode}
              disabled={Boolean(taskId)}
              onChange={(event) => setPermissionMode(event.target.value as AiPermissionMode)}
            >
              <option value="readonly">只读</option>
              <option value="ask" disabled={!selectedAgentSupportsAsk}>需要时询问</option>
            </select>
          ) : null}
        </div>
        <div className="ai-conversation-header-actions">
          <button type="button" className="quiet-button" ref={environmentButtonRef} onClick={() => setEnvironmentOpen(true)}>
            <GearSix size={16} />管理本机 AI
          </button>
          <button type="button" className="quiet-button" ref={historyButtonRef} onClick={() => setHistoryOpen(true)}>
            <ClockCounterClockwise size={16} />历史会话
          </button>
          {activeConversation && activeConversation.status !== "closed" ? (
            <button type="button" className="quiet-button" disabled={closing || activeTurnIsRunning} onClick={() => void closeConversation()}>
              {closing ? "结束中…" : "结束会话"}
            </button>
          ) : null}
          {activeConversation ? <button type="button" className="primary-button" onClick={newConversation}><Plus size={15} />新会话</button> : null}
        </div>
      </header>

      {conversationError ? (
        <div className="ai-conversation-error" role="alert">
          <WarningCircle size={17} />
          <span>{conversationError}</span>
          <button type="button" onClick={() => setConversationError(null)}>知道了</button>
        </div>
      ) : null}

      <div className="ai-conversation-shell">
        <section className="ai-conversation-main" aria-label="AI 会话">
          <div
            className="ai-message-scroll"
            ref={messagesRef}
            onScroll={(event) => {
              const node = event.currentTarget;
              followLatest.current = node.scrollHeight - node.scrollTop - node.clientHeight < 72;
            }}
          >
            {!activeConversation || activeConversation.turns.length === 0 ? (
              <div className="ai-conversation-welcome">
                <h2>今天想和 AI 一起处理什么？</h2>
                <p>可以直接提问，也可以先附上一份资料。</p>
              </div>
            ) : (
              activeConversation.turns.map((turn, index) => (
                <ConversationTurnCard
                  key={turn.id}
                  turn={turn}
                  version={completedTurns.findIndex((item) => item.id === turn.id) + 1}
                  isAccepted={activeConversation.acceptedTurnId === turn.id}
                  isImported={activeConversation.importedTurnId === turn.id}
                  accepting={acceptingTurnId === turn.id}
                  importing={importing}
                  openingObsidian={openingObsidian}
                  onAccept={() => void acceptTurn(turn)}
                  onImport={() => void importAcceptedTurn()}
                  onOpenObsidian={() => void openImportedResult()}
                  isLast={index === activeConversation.turns.length - 1}
                />
              ))
            )}
          </div>

          {activeConversation?.pendingPermission ? (
            <div className="ai-permission-prompt" role="alert" aria-live="assertive">
              <div>
                <strong>需要你的确认</strong>
                <span>{safeVisibleText(activeConversation.pendingPermission.title) || "AI 请求执行一次受控操作"}</span>
                {activeConversation.pendingPermission.scope.length > 0 ? (
                  <ul className="ai-permission-scope" aria-label="本次操作范围">
                    {activeConversation.pendingPermission.scope.map((item) => (
                      <li key={item} title={safePermissionScope(item)}>{safePermissionScope(item)}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <div className="ai-permission-prompt-actions">
                {activeConversation.pendingPermission.options.map((option, index) => (
                  <button
                    type="button"
                    key={option.optionId}
                    ref={index === 0 ? permissionFirstActionRef : undefined}
                    className={option.kind === "allow_once" ? "primary-button" : "quiet-button"}
                    disabled={respondingPermissionId === activeConversation.pendingPermission?.id}
                    onClick={() => void respondPermission(option.optionId)}
                  >
                    {option.kind === "allow_once" ? "允许一次" : "拒绝"}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <ConversationComposer
            value={draft}
            inputDisabled={inputDisabled}
            inputDisabledPlaceholder={inputDisabledPlaceholder}
            sendDisabled={sendBlocked}
            sending={sending || starting}
            activeTurn={activeTurn}
            cancelling={cancelling}
            composing={composing}
            onChange={setDraft}
            onSend={() => void sendMessage()}
            onCancel={() => void cancelTurn()}
          />
        </section>
      </div>

      {agentError && !activeConversation ? <div className="ai-agent-inline-error" role="alert">{agentError}</div> : null}
      {loading ? <span className="ai-conversation-loading" role="status">正在连接…</span> : null}

      {historyOpen ? (
        <div className="ai-history-overlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setHistoryOpen(false);
        }}>
          <div className="ai-history-drawer">
            <DetailDrawer title="历史会话" onClose={() => setHistoryOpen(false)} returnFocus={historyButtonRef.current}>
              {visibleConversations.length === 0 ? (
                <EmptyState title="还没有历史会话" description="完成第一次对话后，会话会保存在这里。" />
              ) : (
                <div className="ai-history-list">
                  {visibleConversations.map((conversation) => (
                    <button
                      type="button"
                      key={conversation.id}
                      className={conversation.id === activeConversation?.id ? "is-selected" : ""}
                      onClick={() => void openConversation(conversation)}
                    >
                      <strong>{conversation.context?.title ?? conversation.turns[0]?.userText.slice(0, 36) ?? "自由协作"}</strong>
                      <span>{providerName(agents, conversation.provider)} · {readableDate(conversation.updatedAt)}</span>
                      <small>{conversation.turns.length} 轮对话{conversation.acceptedTurnId ? " · 已采用成果" : ""}</small>
                    </button>
                  ))}
                </div>
              )}
            </DetailDrawer>
          </div>
        </div>
      ) : null}

      {contextPickerOpen && !activeConversation ? (
        <div className="ai-history-overlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setContextPickerOpen(false);
        }}>
          <div className="ai-context-drawer">
            <DetailDrawer title="添加资料" onClose={() => setContextPickerOpen(false)}>
              <div className="ai-context-drawer-content">
                {sourceTask ? <div className="ai-source-task-note"><span>任务</span><strong>{sourceTask.title}</strong></div> : null}
                {sourceTaskIsProjectTask ? <div className="ai-composer-error" role="alert">这项任务已关联项目，不能在这里添加资料。</div> : null}
                {sourceTaskError ? <div className="ai-composer-error" role="alert">{sourceTaskError}</div> : null}
                <label className="form-field">
                  <span>资料类型</span>
                  <select
                    aria-label="资料类型"
                    value={contextKind}
                    onChange={(event) => {
                      setContextKind(event.target.value as AiContextKind);
                      setContextId("");
                    }}
                  >
                    {CONTEXT_KINDS.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
                  </select>
                </label>
                <label className="form-field">
                  <span>选择资料</span>
                  <select aria-label="任务资料" value={contextId} onChange={(event) => setContextId(event.target.value)}>
                    <option value="">选择一份资料</option>
                    {contextOptions.map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}
                  </select>
                </label>
                {contextLoadError ? (
                  <div className="ai-composer-error" role="alert">资料暂时无法载入 <button type="button" onClick={() => void loadContextSources()}>重试</button></div>
                ) : null}
                <button
                  type="button"
                  className="primary-button full-width"
                  disabled={!selectedContext || sourceTaskSaving || sourceTaskIsProjectTask}
                  onClick={() => {
                    if (sourceTask && !sourceTaskHasContext) void saveSourceTaskLink();
                    else setContextPickerOpen(false);
                  }}
                >
                  {sourceTaskSaving ? "保存中…" : sourceTask ? "关联资料" : "添加资料"}
                </button>
              </div>
            </DetailDrawer>
          </div>
        </div>
      ) : null}

      {environmentOpen ? (
        <div className="ai-history-overlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setEnvironmentOpen(false);
        }}>
          <div className="ai-environment-drawer">
            <DetailDrawer title="本机 AI" onClose={() => setEnvironmentOpen(false)} returnFocus={environmentButtonRef.current}>
              <div className="ai-environment-content">
                <div className="ai-environment-intro">
                  <p>已经可用的 AI 会直接出现在工作台。缺少时可选择安装，登录会在本机终端完成。</p>
                  <button type="button" className="quiet-button" disabled={agentLoading} onClick={() => void loadAgents(true)}>
                    <ArrowClockwise size={14} />{agentLoading ? "检测中…" : "重新检测"}
                  </button>
                </div>
                {environmentJob ? (
                  <div className={`ai-environment-job is-${environmentJob.status}`} role="status">
                    <strong>{agents.find((agent) => agent.id === environmentJob.provider)?.displayName ?? "本机 AI"}</strong>
                    <span>{environmentJob.message}</span>
                  </div>
                ) : null}
                {environmentError ? <div className="ai-composer-error" role="alert">{environmentError}</div> : null}
                <div className="ai-environment-list">
                  {agents.map((agent) => {
                    const action = environmentActionFor(agent);
                    const busy = environmentJob && ["queued", "running"].includes(environmentJob.status);
                    const active = activeConversation?.provider === agent.id && activeConversation.status !== "closed";
                    return (
                      <article className="ai-environment-row" key={agent.id}>
                        <div>
                          <strong>{agent.displayName}</strong>
                          <span>{environmentStatus(agent)}</span>
                          <small>
                            {agent.version ? `本机 ${agent.version}` : "尚未检测到本机版本"}
                            {agent.latestStable ? ` · 已知版本 ${agent.latestStable}` : ""}
                            {agent.testedVersion ? ` · 已验证 ${agent.testedVersion}` : ""}
                          </small>
                        </div>
                        <div className="ai-environment-row-actions">
                          <a href={agent.officialSource} target="_blank" rel="noreferrer noopener">官方说明</a>
                          {action ? (
                            <button
                              type="button"
                              className="primary-button"
                              disabled={Boolean(busy || active)}
                              title={active ? "请先结束当前会话" : undefined}
                              onClick={() => void runEnvironmentAction(agent, action)}
                            >
                              {environmentJob?.provider === agent.id && busy ? "处理中…" : environmentActionLabel(action)}
                            </button>
                          ) : isAiAgentRunnable(agent) ? (
                            <span className="ai-environment-ready"><CheckCircle size={15} weight="fill" />可使用</span>
                          ) : <span className="ai-environment-unavailable">暂不可用</span>}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            </DetailDrawer>
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface ConversationTurnCardProps {
  turn: AiConversationTurn;
  version: number;
  isAccepted: boolean;
  isImported: boolean;
  accepting: boolean;
  importing: boolean;
  openingObsidian: boolean;
  onAccept: () => void;
  onImport: () => void;
  onOpenObsidian: () => void;
  isLast: boolean;
}

function ConversationTurnCard(props: ConversationTurnCardProps) {
  const details = props.turn.events.filter((event) => ["thought", "plan", "tool_call", "tool_update", "diff", "status"].includes(event.type));
  const canAccept = props.turn.status === "completed" && Boolean(props.turn.outputSha256 && props.turn.assistantText.trim());
  const streamedText = props.turn.events
    .filter((event) => event.type === "message" && typeof event.text === "string")
    .map((event) => event.text)
    .join("");
  const visibleAssistantText = props.turn.assistantText || streamedText;
  return (
    <article className="ai-turn" data-turn-status={props.turn.status}>
      <div className="ai-user-message"><p>{props.turn.userText}</p></div>
      <div
        className="ai-assistant-message"
        aria-live={props.isLast && isAiConversationTurnActive(props.turn) ? "polite" : undefined}
        aria-atomic={props.isLast && isAiConversationTurnActive(props.turn) ? "false" : undefined}
      >
        <div className="ai-assistant-message-heading"><strong>AI</strong><span>{TURN_STATUS_LABEL[props.turn.status]}</span></div>
        {visibleAssistantText ? <div className="ai-assistant-copy"><AssistantMarkdown text={visibleAssistantText} /></div> : null}
        {isAiConversationTurnActive(props.turn) && !visibleAssistantText ? (
          <div className="ai-assistant-working" role={props.isLast ? "status" : undefined}>正在整理回复…</div>
        ) : null}
        {props.turn.status === "failed" ? <div className="ai-turn-error" role="alert">{props.turn.error || "这次回复没有完成，可以重新发送。"}</div> : null}
        {props.turn.status === "cancelled" ? <div className="ai-turn-muted">这次回复已停止。</div> : null}
        {details.length > 0 ? (
          <details className="ai-turn-details">
            <summary>查看处理过程</summary>
            <ul>{details.map((event) => <li key={event.id}><span>{eventLabel(event)}</span><p>{eventSummary(event)}</p></li>)}</ul>
          </details>
        ) : null}
        {canAccept ? (
          <div className="ai-turn-actions">
            {props.isAccepted ? <span className="ai-version-accepted"><CheckCircle size={15} weight="fill" />已采用 V{props.version}</span> : (
              <button type="button" className="quiet-button" disabled={props.accepting} onClick={props.onAccept}>
                <Check size={15} />{props.accepting ? "采用中…" : `采用这一版${props.version > 0 ? ` V${props.version}` : ""}`}
              </button>
            )}
            {props.isAccepted && !props.isImported ? (
              <button type="button" className="primary-button" disabled={props.importing} onClick={props.onImport}>
                <FileText size={15} />{props.importing ? "保存中…" : "确认保存到 Obsidian"}
              </button>
            ) : null}
            {props.isAccepted && props.isImported ? (
              <button type="button" className="quiet-button" disabled={props.openingObsidian} onClick={props.onOpenObsidian}>
                <CheckCircle size={15} weight="fill" />{props.openingObsidian ? "正在打开…" : "已保存 · 打开查看"}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

interface ConversationComposerProps {
  value: string;
  inputDisabled: boolean;
  inputDisabledPlaceholder: string | null;
  sendDisabled: boolean;
  sending: boolean;
  activeTurn: AiConversationTurn | null;
  cancelling: boolean;
  composing: React.MutableRefObject<boolean>;
  onChange: (value: string) => void;
  onSend: () => void;
  onCancel: () => void;
}

function ConversationComposer(props: ConversationComposerProps) {
  const running = isAiConversationTurnActive(props.activeTurn);
  return (
    <div className="ai-conversation-composer">
      <textarea
        aria-label="继续提问"
        rows={2}
        maxLength={8000}
        value={props.value}
        disabled={props.inputDisabled}
        placeholder={props.inputDisabledPlaceholder ?? (running ? "可以先写下一条，回复完成后发送" : "输入消息…")}
        onCompositionStart={() => { props.composing.current = true; }}
        onCompositionEnd={() => { props.composing.current = false; }}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey) return;
          if (event.nativeEvent.isComposing || event.keyCode === 229 || props.composing.current) return;
          event.preventDefault();
          if (!props.sendDisabled) props.onSend();
        }}
      />
      <div className="ai-composer-footer">
        <span>Enter 发送 · Shift + Enter 换行</span>
        {running ? (
          <button type="button" className="quiet-button" onClick={props.onCancel} disabled={props.cancelling}>
            <Stop size={15} weight="fill" />{props.cancelling ? "停止中…" : "停止回复"}
          </button>
        ) : (
          <button type="button" className="primary-button" onClick={props.onSend} disabled={props.sendDisabled}>
            <PaperPlaneTilt size={15} weight="fill" />{props.sending ? "发送中…" : "发送"}
          </button>
        )}
      </div>
    </div>
  );
}
