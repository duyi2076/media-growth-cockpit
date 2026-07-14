import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Target,
  CheckCircle,
  Circle,
  Database,
  Warning,
  Plus,
  PencilSimple,
  TrashSimple,
  ArrowUp,
  ArrowDown,
  Check,
  X,
} from "phosphor-react";
import { ModuleHeader } from "@/components/ui/ModuleHeader";
import { Card } from "@/components/ui/Card";
import { DetailDrawer } from "@/components/ui/DetailDrawer";
import { WorkbenchGrid } from "@/components/ui/WorkbenchGrid";
import {
  useWorkbenchIndex,
} from "@/data/adapter";
import { getAiConversations } from "@/data/aiConversationsClient";
import { useDailyTasks, type DailyTasksSyncState } from "@/hooks/useDailyTasks";
import { useActionTargets, type ActionTargetSyncState } from "@/hooks/useActionTargets";
import { usePlatformFollowers } from "@/hooks/usePlatformFollowers";
import type { ActionTarget, ActionTargetId, PlatformAccount, TaskItem, TodayTask } from "@/types";

const EMPTY_PLATFORM_ACCOUNTS: PlatformAccount[] = [];

function dailyTaskConversationKey(date: string, taskId: string): string {
  return `${date}:${taskId}`;
}

export function GrowthPage() {
  const { data, loading, error, refresh } = useWorkbenchIndex();
  const navigate = useNavigate();
  const growth = data?.growth;
  const platformFollowers = usePlatformFollowers(growth?.accounts ?? EMPTY_PLATFORM_ACCOUNTS, refresh);
  const [conversationByTask, setConversationByTask] = useState<Record<string, string>>({});
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getAiConversations()
      .then((conversations) => {
        if (!active) return;
        const linked: Record<string, string> = {};
        for (const conversation of conversations) {
          if (conversation.sourceTask) {
            const key = dailyTaskConversationKey(conversation.sourceTask.date, conversation.sourceTask.id);
            if (!linked[key]) linked[key] = conversation.id;
          }
        }
        setConversationByTask(linked);
      })
      .catch(() => {
        // AI 状态不影响今日任务的读取和编辑。
      });
    return () => { active = false; };
  }, []);

  const openTaskLink = (task: TodayTask) => {
    if (task.linkType === "task" && task.linkId) {
      setSelectedTaskId(task.linkId);
    }
  };

  const delegateTaskToAi = (task: TodayTask, date: string) => {
    if (task.linkType === "task") return;
    const params = new URLSearchParams({ taskId: task.id });
    const conversationId = conversationByTask[dailyTaskConversationKey(date, task.id)];
    if (conversationId) params.set("conversationId", conversationId);
    navigate(`/ai?${params.toString()}`);
  };

  if (loading) {
    return <LoadingState />;
  }

  if (error || !growth) {
    return <ErrorState message={error || "未知错误"} />;
  }

  const growthSummary = growth.summary;
  const selectedTask = data.tasks.find((task) => task.id === selectedTaskId) ?? null;
  const taskDetail = selectedTask ? (
    <DetailDrawer title={selectedTask.title} onClose={() => setSelectedTaskId(null)}>
      <ProjectTaskDetail task={selectedTask} />
    </DetailDrawer>
  ) : null;

  return (
    <div>
      <ModuleHeader
        title="增长总览"
        goal={`每天 10 秒内看懂增长目标还有多远，今天该做什么。`}
      />

      <WorkbenchGrid
        className="growth-workbench"
        detail={taskDetail}
        onCloseDetail={() => setSelectedTaskId(null)}
      >
        <div className="growth-overview-stack">
          <Card>
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <div className="growth-goal-heading">
                <div className="growth-goal-title">
                  <Target size={20} color="var(--color-primary)" />
                  <span>目标进度</span>
                </div>
                <ul className="platform-band platform-band-inline" aria-label="平台粉丝">
                  {platformFollowers.accounts.map((account) => (
                    <PlatformMetric
                      key={account.id}
                      account={account}
                      disabled={platformFollowers.state === "loading" || platformFollowers.state === "saving" || platformFollowers.state === "conflict"}
                      onSave={platformFollowers.saveFollower}
                      onEditStart={platformFollowers.beginEditing}
                      onEditEnd={platformFollowers.endEditing}
                    />
                  ))}
                </ul>
                {platformFollowers.state === "error" || platformFollowers.state === "conflict" ? (
                  <button
                    type="button"
                    className="platform-followers-status"
                    onClick={platformFollowers.state === "conflict" ? platformFollowers.acceptExternal : platformFollowers.retry}
                  >
                    {platformFollowers.message ?? "重新读取"}
                  </button>
                ) : null}
              </div>
              <div className="growth-goal-metrics">
                <Metric label="已涨粉" value={growthSummary.gainedFollowers.toLocaleString("zh-CN")} />
                <Metric label="涨粉目标" value={growthSummary.growthTarget.toLocaleString("zh-CN")} />
                <Metric label="还需涨粉" value={growthSummary.growthGap.toLocaleString("zh-CN")} />
                <Metric label="完成度" value={`${(growthSummary.completionRate * 100).toFixed(1)}%`} />
              </div>
              <div
                style={{
                  height: "8px",
                  backgroundColor: "var(--color-border-subtle)",
                  borderRadius: "4px",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${growthSummary.completionRate * 100}%`,
                    height: "100%",
                    backgroundColor: "var(--color-primary)",
                  }}
                />
              </div>
              <div style={{ fontSize: "var(--text-xs)", color: "var(--color-text-tertiary)" }}>
                基线 {growthSummary.baselineFollowers.toLocaleString("zh-CN")} · 当前总粉丝 {growthSummary.currentFollowers.toLocaleString("zh-CN")} · 达标总粉丝 {growthSummary.expectedFollowers.toLocaleString("zh-CN")} · 数据日期 {growthSummary.asOf} · 周期 {growthSummary.startDate ?? "待确认"} 至 {growthSummary.deadline ?? "待确认"}
              </div>
            </div>
          </Card>

          <ActionTargetsSection initialTargets={data.actionTargets} />

          <DailyTasksCard
            fallbackTasks={data.todayTasks}
            onOpenTask={openTaskLink}
            onDelegateToAi={delegateTaskToAi}
            conversationByTask={conversationByTask}
          />
        </div>
      </WorkbenchGrid>
    </div>
  );
}

function ProjectTaskDetail({ task }: { task: TaskItem }) {
  const rows = [
    ["状态", task.status],
    ["任务类型", task.type],
    ["负责人", task.assignee ?? "待分配"],
    ["截止日期", task.dueAt ?? "待确认"],
  ];

  return (
    <div aria-label="项目任务详情" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {task.summary ? <p style={{ color: "var(--color-text-secondary)", lineHeight: 1.65 }}>{task.summary}</p> : null}
      <dl style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: "grid", gridTemplateColumns: "76px 1fr", gap: "12px" }}>
            <dt style={{ color: "var(--color-text-tertiary)", fontSize: "var(--text-xs)" }}>{label}</dt>
            <dd style={{ color: "var(--color-text-primary)", fontSize: "var(--text-sm)" }}>{value}</dd>
          </div>
        ))}
      </dl>
      {task.tags.length > 0 ? (
        <div aria-label="任务标签" style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
          {task.tags.map((tag) => (
            <span key={tag} style={{ padding: "3px 8px", borderRadius: "999px", background: "var(--color-bg)", color: "var(--color-text-secondary)", fontSize: "var(--text-xs)" }}>
              {tag}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ActionTargetsSection({ initialTargets }: { initialTargets: ActionTarget[] }) {
  const { targets, campaignStartedAt, state, message, saveTarget, startCampaign, retry, acceptExternal, beginEditing, endEditing } = useActionTargets(initialTargets);
  const [confirmingStart, setConfirmingStart] = useState(false);
  const controlsDisabled = state === "loading" || state === "saving" || state === "conflict";
  return (
    <section aria-labelledby="action-targets-title">
      <div className="action-targets-heading">
        <div id="action-targets-title" className="action-targets-title">行动目标</div>
        <div className="action-targets-controls">
          <ActionTargetsStatus state={state} message={message} onRetry={retry} onAcceptExternal={acceptExternal} />
          {campaignStartedAt ? (
            <span className="campaign-started-at">统计自 {campaignStartedAt.slice(0, 10)}</span>
          ) : confirmingStart ? (
            <div className="campaign-start-confirm" role="group" aria-label="确认正式开始统计">
              <span>从现在开始计数？</span>
              <button
                type="button"
                onClick={() => void startCampaign().then((saved) => { if (saved) setConfirmingStart(false); })}
                disabled={controlsDisabled}
              >
                确认开始
              </button>
              <button type="button" onClick={() => setConfirmingStart(false)} disabled={controlsDisabled}>取消</button>
            </div>
          ) : (
            <button type="button" className="campaign-start-button" onClick={() => setConfirmingStart(true)} disabled={controlsDisabled}>
              正式开始统计
            </button>
          )}
        </div>
      </div>
      <Card style={{ padding: "10px" }}>
        <div className="action-targets-grid">
          {targets.map((item) => (
            <ActionTargetCard
              key={item.id}
              item={item}
              disabled={controlsDisabled}
              onSave={saveTarget}
              onEditStart={beginEditing}
              onEditEnd={endEditing}
            />
          ))}
        </div>
      </Card>
    </section>
  );
}

function ActionTargetCard({
  item,
  disabled,
  onSave,
  onEditStart,
  onEditEnd,
}: {
  item: ActionTarget;
  disabled: boolean;
  onSave: (id: ActionTargetId, value: number | null) => Promise<boolean>;
  onEditStart: () => void;
  onEditEnd: () => void;
}) {
  const [draft, setDraft] = useState(item.target?.toString() ?? "");
  const percentage = item.completionRate === null ? null : Math.min(100, Math.round(item.completionRate * 100));

  useEffect(() => {
    setDraft(item.target?.toString() ?? "");
  }, [item.target]);

  const saveDraft = async () => {
    const trimmed = draft.trim();
    const value = trimmed === "" ? null : Number(trimmed);
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > 1_000_000)) {
      setDraft(item.target?.toString() ?? "");
      return;
    }
    if (value === item.target) return;
    await onSave(item.id, value);
  };

  return (
    <div className="action-target-item">
      <div className="action-target-label">{item.label}</div>
      <div className="action-target-progress-text">
        <strong>{item.current}</strong>
        <span>/</span>
        <form
          className="action-target-editor"
          onSubmit={(event) => {
            event.preventDefault();
            event.currentTarget.querySelector("input")?.blur();
          }}
        >
          <input
            type="number"
            min="1"
            max="1000000"
            inputMode="numeric"
            value={draft}
            placeholder="目标"
            onChange={(event) => setDraft(event.target.value)}
            onFocus={onEditStart}
            onBlur={() => {
              void saveDraft().finally(onEditEnd);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setDraft(item.target?.toString() ?? "");
                event.currentTarget.blur();
              }
            }}
            aria-label={`${item.label}目标数量`}
            disabled={disabled}
          />
        </form>
        <span>{item.unit}</span>
      </div>
      <div className="action-target-bar" aria-label={`${item.label}完成度${percentage === null ? "待设置" : `${percentage}%`}`}>
        <div style={{ width: `${percentage ?? 0}%` }} />
      </div>
    </div>
  );
}

function ActionTargetsStatus({
  state,
  message,
  onRetry,
  onAcceptExternal,
}: {
  state: ActionTargetSyncState;
  message: string | null;
  onRetry: () => void;
  onAcceptExternal: () => void;
}) {
  if (state === "error") return <button type="button" className="action-target-status is-error" onClick={onRetry}>{message ?? "重新读取"}</button>;
  if (state === "conflict") return <button type="button" className="action-target-status is-warning" onClick={onAcceptExternal}>{message ?? "载入最新目标"}</button>;
  if (state === "saving" || state === "loading") return <span className="action-target-status">{state === "saving" ? "保存中…" : "读取中…"}</span>;
  return null;
}

function PlatformMetric({
  account,
  disabled,
  onSave,
  onEditStart,
  onEditEnd,
}: {
  account: PlatformAccount;
  disabled: boolean;
  onSave: (id: string, value: number) => Promise<boolean>;
  onEditStart: () => void;
  onEditEnd: () => void;
}) {
  const [draft, setDraft] = useState(String(account.currentFollowers));

  useEffect(() => { setDraft(String(account.currentFollowers)); }, [account.currentFollowers]);

  const save = async () => {
    const value = Number(draft);
    if (!Number.isInteger(value) || value < 0 || value > 100_000_000) {
      setDraft(String(account.currentFollowers));
      return;
    }
    if (value === account.currentFollowers) return;
    await onSave(account.id, value);
  };

  return (
    <li className="platform-band-item">
      <span className="platform-band-name">{account.platform}</span>
      <input
        className="platform-band-input"
        type="number"
        min="0"
        max="100000000"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={onEditStart}
        onBlur={() => {
          void save().finally(onEditEnd);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(String(account.currentFollowers));
            event.currentTarget.blur();
          }
        }}
        aria-label={`${account.platform}当前粉丝数`}
        disabled={disabled}
      />
    </li>
  );
}

function DailyTasksCard({
  fallbackTasks,
  onOpenTask,
  onDelegateToAi,
  conversationByTask,
}: {
  fallbackTasks: TodayTask[];
  onOpenTask: (task: TodayTask) => void;
  onDelegateToAi: (task: TodayTask, date: string) => void;
  conversationByTask: Record<string, string>;
}) {
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState("");
  const {
    date,
    tasks,
    syncState,
    updatedAt,
    message,
    canEdit,
    save,
    retry,
    acceptExternal,
  } = useDailyTasks(fallbackTasks, editingId !== null);
  const isFull = tasks.length >= 3;

  const startAdding = () => {
    if (!canEdit || isFull) return;
    setEditingId("new");
    setDraft("");
  };

  const startEditing = (task: TodayTask) => {
    if (!canEdit) return;
    setEditingId(task.id);
    setDraft(task.title);
  };

  const cancelEditing = () => {
    setEditingId(null);
    setDraft("");
  };

  const commitDraft = () => {
    const title = draft.trim();
    if (!title) return;
    if (editingId === "new") {
      const nextTask: TodayTask = {
        id: `daily-${date}-${crypto.randomUUID()}`,
        title,
        done: false,
        linkId: null,
        linkType: null,
      };
      void save([...tasks, nextTask]);
    } else if (editingId) {
      void save(tasks.map((task) => (task.id === editingId ? { ...task, title } : task)));
    }
    cancelEditing();
  };

  const updateTasks = (nextTasks: TodayTask[]) => {
    if (!canEdit) return;
    void save(nextTasks);
  };

  const saveSuggestedTasks = () => {
    if (!canEdit || tasks.length === 0) return;
    void save(tasks);
  };

  const delegateTask = async (task: TodayTask) => {
    if (!canEdit) return;
    if (syncState !== "saved") {
      const saved = await save(tasks);
      if (!saved) return;
    }
    onDelegateToAi(task, date);
  };

  const moveTask = (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= tasks.length) return;
    const nextTasks = [...tasks];
    [nextTasks[index], nextTasks[nextIndex]] = [nextTasks[nextIndex], nextTasks[index]];
    updateTasks(nextTasks);
  };

  return (
    <Card>
      <div className="daily-tasks-card">
      <div className="daily-tasks-header">
        <div>
          <div className="daily-tasks-title">今日三件事</div>
          <div className="daily-tasks-date">{date}</div>
        </div>
        <button
          type="button"
          className="daily-task-add"
          onClick={startAdding}
          disabled={!canEdit || isFull || editingId !== null}
          aria-label="新增今日任务"
          title={isFull ? "今日任务最多三条" : "新增今日任务"}
        >
          <Plus size={16} weight="bold" />
          新增
        </button>
      </div>

      {editingId === "new" ? (
        <TaskEditor
          value={draft}
          onChange={setDraft}
          onSave={commitDraft}
          onCancel={cancelEditing}
          label="新增今日任务"
        />
      ) : null}

      {tasks.length > 0 ? (
        <ul className="daily-task-list">
          {tasks.map((task, index) =>
            editingId === task.id ? (
              <li key={task.id}>
                <TaskEditor
                  value={draft}
                  onChange={setDraft}
                  onSave={commitDraft}
                  onCancel={cancelEditing}
                  label={`编辑任务：${task.title}`}
                />
              </li>
            ) : (
              <TodayTaskItem
                key={task.id}
                task={task}
                index={index}
                total={tasks.length}
                disabled={!canEdit || editingId !== null}
                onToggle={() =>
                  updateTasks(
                    tasks.map((item) =>
                      item.id === task.id ? { ...item, done: !item.done } : item
                    )
                  )
                }
                onOpen={() => onOpenTask(task)}
                onDelegateToAi={() => void delegateTask(task)}
                hasConversation={Boolean(conversationByTask[dailyTaskConversationKey(date, task.id)])}
                onEdit={() => startEditing(task)}
                onDelete={() => updateTasks(tasks.filter((item) => item.id !== task.id))}
                onMoveUp={() => moveTask(index, -1)}
                onMoveDown={() => moveTask(index, 1)}
              />
            )
          )}
        </ul>
      ) : (
        <div className="daily-task-empty">今天还没有任务，先添加最重要的一件事。</div>
      )}

      {isFull ? <div className="daily-task-limit">今日任务已满（最多 3 条）</div> : null}
        <DailyTasksStatus
          state={syncState}
          updatedAt={updatedAt}
          message={message}
          canSaveSuggestedTasks={syncState === "unsaved" && tasks.length > 0 && canEdit}
          onSaveSuggestedTasks={saveSuggestedTasks}
          onRetry={() => void retry()}
          onAcceptExternal={() => {
            acceptExternal();
            cancelEditing();
          }}
        />
      </div>
    </Card>
  );
}

function TaskEditor({
  value,
  onChange,
  onSave,
  onCancel,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  label: string;
}) {
  return (
    <div className="daily-task-editor">
      <input
        autoFocus
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter") onSave();
          if (event.key === "Escape") onCancel();
        }}
        aria-label={label}
        placeholder="写下今天要完成的事"
        maxLength={120}
      />
      <button type="button" onClick={onSave} disabled={!value.trim()} aria-label="保存任务">
        <Check size={16} weight="bold" />
      </button>
      <button type="button" onClick={onCancel} aria-label="取消编辑">
        <X size={16} />
      </button>
    </div>
  );
}

function TodayTaskItem({
  task,
  index,
  total,
  disabled,
  onToggle,
  onOpen,
  onDelegateToAi,
  hasConversation,
  onEdit,
  onDelete,
  onMoveUp,
  onMoveDown,
}: {
  task: TodayTask;
  index: number;
  total: number;
  disabled: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onDelegateToAi: () => void;
  hasConversation: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const isProjectTask = task.linkType === "task";
  return (
    <li className={`daily-task-row${task.done ? " is-done" : ""}`}>
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-pressed={task.done}
        aria-label={task.done ? `将“${task.title}”标记为未完成` : `将“${task.title}”标记为完成`}
        className="daily-task-toggle"
      >
        {task.done ? <CheckCircle size={20} weight="fill" /> : <Circle size={20} />}
      </button>
      {task.linkType === "task" && task.linkId ? (
        <button
          type="button"
          onClick={onOpen}
          className="daily-task-text is-linked"
        >
          {task.title}
        </button>
      ) : (
        <span className="daily-task-text">{task.title}</span>
      )}
      <button
        type="button"
        className={`daily-task-ai${hasConversation ? " is-delivered" : ""}`}
        onClick={onDelegateToAi}
        disabled={disabled || isProjectTask}
        aria-label={isProjectTask
          ? `“${task.title}”已关联项目任务，不能交给 AI`
          : hasConversation
            ? `继续“${task.title}”的 AI 协作`
            : `将“${task.title}”交给 AI`}
        title={isProjectTask ? "这项任务已关联项目任务，请先在项目任务中处理" : undefined}
      >
        {isProjectTask ? "项目任务" : hasConversation ? "继续协作" : "交给 AI"}
      </button>
      <div className="daily-task-actions" aria-label={`调整任务：${task.title}`}>
        <button type="button" onClick={onMoveUp} disabled={disabled || index === 0} aria-label="上移任务">
          <ArrowUp size={15} />
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={disabled || index === total - 1}
          aria-label="下移任务"
        >
          <ArrowDown size={15} />
        </button>
        <button type="button" onClick={onEdit} disabled={disabled} aria-label={`编辑任务：${task.title}`}>
          <PencilSimple size={15} />
        </button>
        <button type="button" onClick={onDelete} disabled={disabled} aria-label={`删除任务：${task.title}`}>
          <TrashSimple size={15} />
        </button>
      </div>
    </li>
  );
}

function DailyTasksStatus({
  state,
  updatedAt,
  message,
  canSaveSuggestedTasks,
  onSaveSuggestedTasks,
  onRetry,
  onAcceptExternal,
}: {
  state: DailyTasksSyncState;
  updatedAt: string | null;
  message: string | null;
  canSaveSuggestedTasks: boolean;
  onSaveSuggestedTasks: () => void;
  onRetry: () => void;
  onAcceptExternal: () => void;
}) {
  const savedTime = updatedAt
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(updatedAt))
    : null;

  if (state === "conflict") {
    return (
      <div className="daily-task-status is-warning" role="alert">
        <span>{message}</span>
        <button type="button" onClick={onAcceptExternal}>载入 Obsidian 版本</button>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="daily-task-status is-error" role="alert">
        <span>{message}</span>
        <button type="button" onClick={onRetry}>重试</button>
      </div>
    );
  }

  if (state === "unsaved") {
    return (
      <div className="daily-task-status" role="status">
        <span>今天的任务尚未保存</span>
        {canSaveSuggestedTasks ? (
          <button type="button" onClick={onSaveSuggestedTasks}>保存为今天任务</button>
        ) : null}
      </div>
    );
  }

  const statusText =
    state === "loading"
      ? "正在读取今日任务…"
      : state === "saving"
        ? "保存中…"
        : `已保存到 Obsidian${savedTime ? ` · ${savedTime}` : ""}`;

  return (
    <div className={`daily-task-status${state === "saved" ? " is-saved" : ""}`} role="status">
      {statusText}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: "10px",
        borderRadius: "var(--radius-md)",
        backgroundColor: "var(--color-bg)",
      }}
    >
      <div style={{ fontSize: "var(--text-xs)", color: "var(--color-text-tertiary)" }}>{label}</div>
      <div style={{ fontSize: "var(--text-xl)", fontWeight: 700, marginTop: "2px" }}>{value}</div>
    </div>
  );
}

export function LoadingState() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "48px 24px",
        color: "var(--color-text-tertiary)",
        gap: "12px",
      }}
    >
      <Database size={32} />
      <div>正在加载数据…</div>
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "48px 24px",
        color: "var(--color-risk)",
        gap: "12px",
      }}
    >
      <Warning size={32} />
      <div>数据加载失败：{message}</div>
    </div>
  );
}
