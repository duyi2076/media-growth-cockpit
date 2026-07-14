import type { ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  onClick?: () => void;
  selected?: boolean;
  ariaLabel?: string;
  style?: React.CSSProperties;
}

export function Card({ children, onClick, selected, ariaLabel, style }: CardProps) {
  return (
    <div
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
      role={onClick ? "button" : undefined}
      aria-label={onClick ? ariaLabel : undefined}
      tabIndex={onClick ? 0 : undefined}
      style={{
        backgroundColor: "var(--color-surface)",
        border: `1px solid ${selected ? "var(--color-primary)" : "var(--color-border)"}`,
        borderRadius: "var(--radius-md)",
        padding: "14px",
        boxShadow: selected ? "var(--shadow-md)" : "var(--shadow-sm)",
        cursor: onClick ? "pointer" : "default",
        transition: "border-color 0.15s, box-shadow 0.15s",
        ...style,
      }}
    >
      {children}
    </div>
  );
}
