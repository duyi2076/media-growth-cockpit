import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus, Check, ArrowUUpLeft, X, Robot, User, Hand } from "phosphor-react";
import { ModuleHeader } from "@/components/ui/ModuleHeader";
import { SearchInput } from "@/components/ui/SearchInput";
import { FilterSelect } from "@/components/ui/FilterSelect";
import { ViewToggle } from "@/components/ui/ViewToggle";
import { Card } from "@/components/ui/Card";
import { StatusBadge, PriorityBadge } from "@/components/ui/Badge";
import { DetailDrawer } from "@/components/ui/DetailDrawer";
import { EmptyState } from "@/components/ui/EmptyState";
import { WorkbenchGrid } from "@/components/ui/WorkbenchGrid";
import {
  useWorkbenchIndex,
  createLocalDemoTask,
  mergeTasksWithLocalState,
  saveTasksLocalState,
} from "@/data/adapter";
import { LoadingState, ErrorState } from "./GrowthPage";
import type { TaskItem, TaskStatus, TaskType, ViewMode } from "@/types";

const statuses: TaskStatus[] = ["待办", "进行中", "阻塞", "待验收", "已完成"];
const statusOptions = statuses.map((s) => ({ value: s, label: s }));
const typeOptions = [
  { value: "人工任务", label: "人工任务" },
  { value: "Agent 任务", label: "Agent 任务" },
  { value: "人机协作任务", label: "人机协作任务" },
];
const priorityOptions = [
  { value: "P0", label: "P0" },
  { value: "P1", label: "P1" },
  { value: "P2", label: "P2" },
];
const skillOptions = [
  { value: "creator-copywriting", label: "creator-copywriting" },
  { value: "creator-xiaohongshu", label: "creator-xiaohongshu" },
  { value: "wechat-account-analytics", label: "wechat-account-analytics" },
  { value: "obsidian-cli", label: "obsidian-cli" },
];

export function TasksPage() {
  const [searchParams] = useSearchParams();
  const { data, loading, error } = useWorkbenchIndex();
  const vaultTasks = data?.tasks ?? [];

  const [tasks, setTasks] = useState<TaskItem[]>(() => mergeTasksWithLocalState(vaultTasks));

  useEffect(() => {
    setTasks(mergeTasksWithLocalState(vaultTasks));
  }, [vaultTasks]);

  useEffect(() => {
    saveTasksLocalState(tasks);
  }, [tasks]);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [view, setView] = useState<ViewMode>("board");
  const [selected, setSelected] = useState<TaskItem | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => {
    const requestedId = searchParams.get("selected");
    if (!requestedId) return;
    const requestedTask = tasks.find((task) => task.id === requestedId);
    if (requestedTask) {
      setShowAdd(false);
      setSelected(requestedTask);
    }
  }, [searchParams, tasks]);

  // 同步 selected 到最新状态
  useEffect(() => {
    if (selected) {
      const updated = tasks.find((t) => t.id === selected.id);
      if (updated) {
        setSelected(updated);
      } else {
        setSelected(null);
      }
    }
  }, [tasks, selected?.id]);

  const filtered = useMemo(() => {
    return tasks.filter((item) => {
      const matchesSearch =
        search.trim() === "" ||
        item.title.toLowerCase().includes(search.toLowerCase()) ||
        item.tags.some((t) => t.toLowerCase().includes(search.toLowerCase()));
      const matchesStatus = statusFilter === "" || item.status === statusFilter;
      const matchesType = typeFilter === "" || item.type === typeFilter;
      const matchesPriority = priorityFilter === "" || item.priority === priorityFilter;
      return matchesSearch && matchesStatus && matchesType && matchesPriority;
    });
  }, [tasks, search, statusFilter, typeFilter, priorityFilter]);

  const hasFilter = search || statusFilter || typeFilter || priorityFilter;

  const columns = useMemo(() => {
    return statuses.map((status) => ({
      status,
      items: filtered.filter((item) => item.status === status),
    }));
  }, [filtered]);

  const updateStatus = (id: string, status: TaskStatus) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, status, updatedAt: new Date().toISOString().slice(0, 10) } : t))
    );
  };

  const addTask = (task: Omit<TaskItem, "id" | "updatedAt" | "demo" | "sourceKind" | "executionMode">) => {
    const newTask = createLocalDemoTask(task);
    setTasks((prev) => [newTask, ...prev]);
    setShowAdd(false);
  };

  const clearSimQueue = () => {
    setSelected(null);
    setTasks(vaultTasks);
  };

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} />;

  const demoCount = tasks.filter((task) => task.sourceKind === "local-demo").length;

  const detail = selected ? (
    <DetailDrawer title={selected.title} onClose={() => setSelected(null)}>
      <TaskDetail
        task={selected}
        onStart={() => updateStatus(selected.id, "进行中")}
        onCompleteSimulation={() => updateStatus(selected.id, "待验收")}
        onApprove={() => updateStatus(selected.id, "已完成")}
        onReject={() => updateStatus(selected.id, "进行中")}
        onFail={() => updateStatus(selected.id, "阻塞")}
      />
    </DetailDrawer>
  ) : showAdd ? (
    <DetailDrawer title="新增任务" onClose={() => setShowAdd(false)}>
      <AddTaskDrawer onClose={() => setShowAdd(false)} onSubmit={addTask} />
    </DetailDrawer>
  ) : null;

  return (
    <div>
      <ModuleHeader title="任务与 Agent" goal="安排人工与 Agent 任务，跟进执行、审核和结果。" />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
          padding: "0 24px 16px",
          flexWrap: "wrap",
          position: "sticky",
          top: "64px",
          zIndex: 40,
          backgroundColor: "var(--color-bg)",
        }}
      >
        <SearchInput value={search} onChange={setSearch} placeholder="搜索任务或标签..." />
        <FilterSelect value={statusFilter} onChange={setStatusFilter} options={statusOptions} placeholder="状态" />
        <FilterSelect value={typeFilter} onChange={setTypeFilter} options={typeOptions} placeholder="类型" />
        <FilterSelect value={priorityFilter} onChange={setPriorityFilter} options={priorityOptions} placeholder="优先级" />
        {hasFilter && (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setStatusFilter("");
              setTypeFilter("");
              setPriorityFilter("");
            }}
            style={{
              padding: "8px 12px",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-md)",
              backgroundColor: "var(--color-surface)",
              color: "var(--color-text-secondary)",
              fontSize: "var(--text-sm)",
            }}
          >
            清除筛选
          </button>
        )}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <ViewToggle value={view} onChange={setView} allowed={["board", "table"]} />
          <button
            type="button"
            onClick={() => { setSelected(null); setShowAdd(true); }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              minHeight: "36px",
              padding: "8px 12px",
              border: "none",
              borderRadius: "var(--radius-md)",
              backgroundColor: "var(--color-primary)",
              color: "var(--color-text-inverse)",
              fontWeight: 500,
            }}
          >
            <Plus size={16} />
            新增任务
          </button>
          {demoCount > 0 && (
            <button
              type="button"
              onClick={clearSimQueue}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                minHeight: "36px",
                padding: "8px 10px",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-md)",
                backgroundColor: "transparent",
                color: "var(--color-text-secondary)",
              }}
            >
              <X size={15} />
              清空新增任务
            </button>
          )}
        </div>
      </div>

      <WorkbenchGrid
        detail={detail}
        onCloseDetail={() => { setSelected(null); setShowAdd(false); }}
      >
        {filtered.length === 0 ? (
          <EmptyState title="无匹配任务" description="尝试调整搜索或筛选条件。" />
        ) : view === "board" ? (
          <BoardView
            columns={columns}
            selected={selected}
            onSelect={(item) => { setShowAdd(false); setSelected(item); }}
            onStatusChange={updateStatus}
          />
        ) : (
          <TableView items={filtered} selected={selected} onSelect={(item) => { setShowAdd(false); setSelected(item); }} />
        )}
      </WorkbenchGrid>
    </div>
  );
}

function BoardView({
  columns,
  selected,
  onSelect,
  onStatusChange,
}: {
  columns: { status: TaskStatus; items: TaskItem[] }[];
  selected: TaskItem | null;
  onSelect: (item: TaskItem) => void;
  onStatusChange: (id: string, status: TaskStatus) => void;
}) {
  return (
    <div style={{ display: "flex", gap: "12px", overflowX: "auto", paddingBottom: "8px" }}>
      {columns.map((col) => (
        <div
          key={col.status}
          style={{
            minWidth: "280px",
            maxWidth: "300px",
            flex: "0 0 auto",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 4px" }}>
            <span style={{ fontWeight: 600, fontSize: "var(--text-sm)" }}>{col.status}</span>
            <span
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--color-text-tertiary)",
                backgroundColor: "var(--color-surface)",
                padding: "2px 6px",
                borderRadius: "var(--radius-sm)",
              }}
            >
              {col.items.length}
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {col.items.map((item) => (
              <TaskCard
                key={item.id}
                task={item}
                selected={selected?.id === item.id}
                onClick={() => onSelect(item)}
                onStatusChange={onStatusChange}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function TableView({
  items,
  selected,
  onSelect,
}: {
  items: TaskItem[];
  selected: TaskItem | null;
  onSelect: (item: TaskItem) => void;
}) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--text-sm)" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--color-border)" }}>
            <th style={{ textAlign: "left", padding: "10px 8px" }}>任务</th>
            <th style={{ textAlign: "left", padding: "10px 8px" }}>状态</th>
            <th style={{ textAlign: "left", padding: "10px 8px" }}>类型</th>
            <th style={{ textAlign: "left", padding: "10px 8px" }}>优先级</th>
            <th style={{ textAlign: "left", padding: "10px 8px" }}>负责人 / Agent</th>
            <th style={{ textAlign: "left", padding: "10px 8px" }}>截止日期</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={item.id}
              style={{
                borderBottom: "1px solid var(--color-border-subtle)",
                backgroundColor: selected?.id === item.id ? "var(--color-primary-subtle)" : "transparent",
              }}
            >
              <td style={{ padding: 0 }}>
                <button
                  type="button"
                  onClick={() => onSelect(item)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    padding: "10px 8px",
                    background: "transparent",
                    border: "none",
                    color: "var(--color-text-primary)",
                    cursor: "pointer",
                  }}
                >
                  <div className="truncate" style={{ fontWeight: 500 }}>{item.title}</div>
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--color-text-tertiary)" }}>{item.summary || "暂无摘要"}</div>
                </button>
              </td>
              <td style={{ padding: "10px 8px" }}><StatusBadge status={item.status} /></td>
              <td style={{ padding: "10px 8px" }}>{item.type}</td>
              <td style={{ padding: "10px 8px" }}>{item.priority ? <PriorityBadge priority={item.priority} /> : "—"}</td>
              <td style={{ padding: "10px 8px" }}>{item.assignedAgent ?? item.assignee}</td>
              <td style={{ padding: "10px 8px", color: "var(--color-text-tertiary)" }}>{item.dueAt ?? "待确认"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TaskCard({
  task,
  selected,
  onClick,
  onStatusChange,
}: {
  task: TaskItem;
  selected: boolean;
  onClick: () => void;
  onStatusChange: (id: string, status: TaskStatus) => void;
}) {
  const TypeIcon = task.type === "Agent 任务" ? Robot : task.type === "人机协作任务" ? Hand : User;

  return (
    <Card selected={selected} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={onClick}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          opacity: 0,
          cursor: "pointer",
        }}
        aria-label={`查看任务：${task.title}`}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: "10px", pointerEvents: "none" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <StatusBadge status={task.status} />
          {task.priority && <PriorityBadge priority={task.priority} />}
        </div>
        <div style={{ fontWeight: 600, fontSize: "var(--text-md)" }} className="line-clamp-2">
          {task.title}
        </div>
        <div style={{ fontSize: "var(--text-sm)", color: "var(--color-text-secondary)" }} className="line-clamp-3">
          {task.summary || "暂无摘要"}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "var(--text-xs)", color: "var(--color-text-tertiary)" }}>
          <TypeIcon size={14} />
          <span>{task.type}</span>
          {task.assignedAgent && <span>· {task.assignedAgent}</span>}
        </div>

      </div>

      {task.status === "待验收" && (
        <div style={{ display: "flex", gap: "6px", marginTop: "10px", position: "relative", zIndex: 1 }}>
          <ActionButton icon={Check} label="通过" variant="success" onClick={() => onStatusChange(task.id, "已完成")} />
          <ActionButton icon={ArrowUUpLeft} label="退回" variant="default" onClick={() => onStatusChange(task.id, "进行中")} />
          <ActionButton icon={X} label="失败" variant="danger" onClick={() => onStatusChange(task.id, "阻塞")} />
        </div>
      )}
    </Card>
  );
}

function ActionButton({
  icon: Icon,
  label,
  variant,
  onClick,
}: {
  icon: typeof Check;
  label: string;
  variant: "success" | "danger" | "default";
  onClick: () => void;
}) {
  const colors = {
    success: { bg: "var(--color-success-subtle)", color: "var(--color-success)" },
    danger: { bg: "var(--color-risk-subtle)", color: "var(--color-risk)" },
    default: { bg: "var(--color-border-subtle)", color: "var(--color-text-secondary)" },
  };
  const c = colors[variant];
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "4px",
        padding: "4px 8px",
        border: "none",
        borderRadius: "var(--radius-sm)",
        backgroundColor: c.bg,
        color: c.color,
        fontSize: "var(--text-xs)",
        fontWeight: 500,
        pointerEvents: "auto",
      }}
    >
      <Icon size={12} />
      {label}
    </button>
  );
}

function TaskDetail({
  task,
  onStart,
  onCompleteSimulation,
  onApprove,
  onReject,
  onFail,
}: {
  task: TaskItem;
  onStart: () => void;
  onCompleteSimulation: () => void;
  onApprove: () => void;
  onReject: () => void;
  onFail: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <StatusBadge status={task.status} />
        {task.priority && <PriorityBadge priority={task.priority} />}
        <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-tertiary)" }}>{task.type}</span>
      </div>

      <Section title="摘要">{task.summary || "暂无摘要"}</Section>
      <Section title="负责人">{task.assignee}</Section>
      {task.assignedAgent && <Section title="Agent">{task.assignedAgent}</Section>}
      {task.skill && <Section title="Skill">{task.skill}</Section>}
      <Section title="输入">{task.inputs.join("、") || "无"}</Section>
      <Section title="预期输出">{task.outputs.join("、") || "无"}</Section>
      <Section title="验收标准">{task.verification || "无"}</Section>
      <Section title="标签">{task.tags.join("、")}</Section>

      {task.demo && task.status === "待办" && (
        <button type="button" onClick={onStart} style={primaryActionStyle}>
          开始执行
        </button>
      )}
      {task.demo && task.status === "进行中" && (
        <button type="button" onClick={onCompleteSimulation} style={primaryActionStyle}>
          提交验收
        </button>
      )}

      {task.status === "待验收" && (
        <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
          <button
            type="button"
            onClick={onApprove}
            style={{
              flex: 1,
              padding: "10px",
              border: "none",
              borderRadius: "var(--radius-md)",
              backgroundColor: "var(--color-success)",
              color: "var(--color-text-inverse)",
              fontWeight: 500,
            }}
          >
            审核通过
          </button>
          <button
            type="button"
            onClick={onReject}
            style={{
              flex: 1,
              padding: "10px",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-md)",
              backgroundColor: "var(--color-surface)",
              color: "var(--color-text-secondary)",
              fontWeight: 500,
            }}
          >
            退回
          </button>
          <button
            type="button"
            onClick={onFail}
            style={{
              flex: 1,
              padding: "10px",
              border: "1px solid var(--color-risk)",
              borderRadius: "var(--radius-md)",
              backgroundColor: "var(--color-surface)",
              color: "var(--color-risk)",
              fontWeight: 500,
            }}
          >
            失败
          </button>
        </div>
      )}

    </div>
  );
}

const primaryActionStyle: React.CSSProperties = {
  padding: "10px",
  border: "none",
  borderRadius: "var(--radius-md)",
  backgroundColor: "var(--color-primary)",
  color: "var(--color-text-inverse)",
  fontWeight: 500,
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
      <div style={{ fontSize: "var(--text-xs)", color: "var(--color-text-tertiary)", fontWeight: 500 }}>{title}</div>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--color-text-primary)", lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}

function AddTaskDrawer({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (task: Omit<TaskItem, "id" | "updatedAt" | "demo" | "sourceKind" | "executionMode">) => void;
}) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [type, setType] = useState<TaskType>("人工任务");
  const [priority, setPriority] = useState("P1");
  const [skill, setSkill] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onSubmit({
      title: title.trim(),
      summary: summary.trim() || "新增任务",
      status: "待办",
      type,
      priority: priority as "P0" | "P1" | "P2" | "P3",
      assignee: "使用者",
      assignedAgent: type === "人工任务" ? null : skill || "creator-copywriting",
      skill: skill || null,
      inputs: [],
      outputs: [],
      verification: "人工确认",
      blockedBy: [],
      source: "驾驶舱新增",
      dueAt: null,
      tags: ["新增"],
    });
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <Field label="任务标题">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          style={{
            width: "100%",
            padding: "8px 12px",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-md)",
            backgroundColor: "var(--color-surface)",
            color: "var(--color-text-primary)",
          }}
        />
      </Field>
      <Field label="摘要">
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={3}
          style={{
            width: "100%",
            padding: "8px 12px",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-md)",
            backgroundColor: "var(--color-surface)",
            color: "var(--color-text-primary)",
            resize: "vertical",
          }}
        />
      </Field>
      <Field label="任务类型">
        <select
          value={type}
          onChange={(e) => setType(e.target.value as TaskType)}
          style={{
            width: "100%",
            padding: "8px 12px",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-md)",
            backgroundColor: "var(--color-surface)",
            color: "var(--color-text-primary)",
          }}
        >
          {typeOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </Field>
      <Field label="优先级">
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          style={{
            width: "100%",
            padding: "8px 12px",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-md)",
            backgroundColor: "var(--color-surface)",
            color: "var(--color-text-primary)",
          }}
        >
          {priorityOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </Field>
      {type !== "人工任务" && (
        <Field label="Skill">
          <select
            value={skill}
            onChange={(e) => setSkill(e.target.value)}
            style={{
              width: "100%",
              padding: "8px 12px",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-md)",
              backgroundColor: "var(--color-surface)",
              color: "var(--color-text-primary)",
            }}
          >
            <option value="">选择 Skill</option>
            {skillOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </Field>
      )}
      <button
        type="submit"
        style={{
          padding: "10px",
          border: "none",
          borderRadius: "var(--radius-md)",
          backgroundColor: "var(--color-primary)",
          color: "var(--color-text-inverse)",
          fontWeight: 500,
        }}
      >
        保存到本地
      </button>
      <button
        type="button"
        onClick={onClose}
        style={{
          padding: "10px",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-md)",
          backgroundColor: "var(--color-surface)",
          color: "var(--color-text-secondary)",
          fontWeight: 500,
        }}
      >
        取消
      </button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <label style={{ fontSize: "var(--text-xs)", color: "var(--color-text-secondary)", fontWeight: 500 }}>{label}</label>
      {children}
    </div>
  );
}
