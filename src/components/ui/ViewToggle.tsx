import { SquaresFour, List, Cards } from "phosphor-react";
import type { ViewMode } from "@/types";

interface ViewToggleProps {
  value: ViewMode;
  onChange: (mode: ViewMode) => void;
  allowed?: ViewMode[];
}

const modes: { mode: ViewMode; icon: typeof SquaresFour; label: string }[] = [
  { mode: "board", icon: SquaresFour, label: "看板" },
  { mode: "table", icon: List, label: "表格" },
  { mode: "card", icon: Cards, label: "卡片" },
];

export function ViewToggle({ value, onChange, allowed = ["board", "table", "card"] }: ViewToggleProps) {
  return (
    <div
      style={{
        display: "inline-flex",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-md)",
        overflow: "hidden",
        backgroundColor: "var(--color-surface)",
      }}
    >
      {modes
        .filter((m) => allowed.includes(m.mode))
        .map((m) => {
          const Icon = m.icon;
          const active = value === m.mode;
          return (
            <button
              key={m.mode}
              type="button"
              onClick={() => onChange(m.mode)}
              aria-pressed={active}
              title={m.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "4px",
                padding: "7px 12px",
                border: "none",
                backgroundColor: active ? "var(--color-primary)" : "transparent",
                color: active ? "var(--color-text-inverse)" : "var(--color-text-secondary)",
                fontSize: "var(--text-sm)",
              }}
            >
              <Icon size={16} />
              <span>{m.label}</span>
            </button>
          );
        })}
    </div>
  );
}
