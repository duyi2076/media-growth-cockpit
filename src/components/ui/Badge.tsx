const statusStyles: Record<string, { bg: string; color: string }> = {
  // 内容状态
  候选选题: { bg: "var(--color-border-subtle)", color: "var(--color-text-secondary)" },
  已立项: { bg: "#e8f0fe", color: "#1a5fb4" },
  待发布: { bg: "#e6f2f1", color: "var(--color-primary)" },
  待核验: { bg: "var(--color-amber-subtle)", color: "var(--color-amber)" },
  已发布: { bg: "var(--color-success-subtle)", color: "var(--color-success)" },
  待复盘: { bg: "#f3e8ff", color: "#7c3aed" },
  已归档: { bg: "var(--color-border-subtle)", color: "var(--color-text-tertiary)" },
  // 任务状态
  待办: { bg: "var(--color-border-subtle)", color: "var(--color-text-secondary)" },
  进行中: { bg: "var(--color-amber-subtle)", color: "var(--color-amber)" },
  阻塞: { bg: "var(--color-risk-subtle)", color: "var(--color-risk)" },
  待验收: { bg: "#e6f2f1", color: "var(--color-primary)" },
  已完成: { bg: "var(--color-success-subtle)", color: "var(--color-success)" },
  // Agent 任务状态
  等待执行: { bg: "var(--color-border-subtle)", color: "var(--color-text-secondary)" },
  执行中: { bg: "var(--color-amber-subtle)", color: "var(--color-amber)" },
  执行失败: { bg: "var(--color-risk-subtle)", color: "var(--color-risk)" },
  // 实验结果
  有效: { bg: "var(--color-success-subtle)", color: "var(--color-success)" },
  无效: { bg: "var(--color-risk-subtle)", color: "var(--color-risk)" },
  证据不足: { bg: "var(--color-amber-subtle)", color: "var(--color-amber)" },
  // 确认状态
  已确认: { bg: "var(--color-success-subtle)", color: "var(--color-success)" },
  待人工确认: { bg: "var(--color-amber-subtle)", color: "var(--color-amber)" },
  // 敏感状态
  公开: { bg: "var(--color-success-subtle)", color: "var(--color-success)" },
  内部: { bg: "var(--color-amber-subtle)", color: "var(--color-amber)" },
  敏感: { bg: "var(--color-risk-subtle)", color: "var(--color-risk)" },
};

interface StatusBadgeProps {
  status: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const style = statusStyles[status] || {
    bg: "var(--color-border-subtle)",
    color: "var(--color-text-secondary)",
  };

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: "2px 8px",
        borderRadius: "var(--radius-sm)",
        backgroundColor: style.bg,
        color: style.color,
        fontSize: "var(--text-xs)",
        fontWeight: 500,
      }}
    >
      {status}
    </span>
  );
}

const priorityColor: Record<string, string> = {
  P0: "var(--color-risk)",
  P1: "var(--color-amber)",
  P2: "var(--color-primary)",
  P3: "var(--color-text-tertiary)",
};

interface PriorityBadgeProps {
  priority: string;
}

export function PriorityBadge({ priority }: PriorityBadgeProps) {
  return (
    <span
      style={{
        fontSize: "var(--text-xs)",
        fontWeight: 700,
        color: priorityColor[priority] || "var(--color-text-secondary)",
      }}
    >
      {priority}
    </span>
  );
}
