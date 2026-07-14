import { MagnifyingGlass } from "phosphor-react";

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
}

export function SearchInput({ value, onChange, placeholder = "搜索标题或关键词...", label = "搜索" }: SearchInputProps) {
  const inputId = `search-${label}`;
  return (
    <div
      style={{
        position: "relative",
        flex: 1,
        minWidth: "200px",
      }}
    >
      <label htmlFor={inputId} className="visually-hidden">{label}</label>
      <MagnifyingGlass
        size={16}
        style={{
          position: "absolute",
          left: "12px",
          top: "50%",
          transform: "translateY(-50%)",
          color: "var(--color-text-tertiary)",
        }}
      />
      <input
        id={inputId}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        style={{
          width: "100%",
          padding: "8px 12px 8px 36px",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-md)",
          backgroundColor: "var(--color-surface)",
          color: "var(--color-text-primary)",
          fontSize: "var(--text-base)",
          outline: "none",
        }}
      />
    </div>
  );
}
