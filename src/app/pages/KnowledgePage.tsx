import { useMemo, useState } from "react";
import { ModuleHeader } from "@/components/ui/ModuleHeader";
import { SearchInput } from "@/components/ui/SearchInput";
import { FilterSelect } from "@/components/ui/FilterSelect";
import { Card } from "@/components/ui/Card";
import { StatusBadge } from "@/components/ui/Badge";
import { DetailDrawer } from "@/components/ui/DetailDrawer";
import { EmptyState } from "@/components/ui/EmptyState";
import { WorkbenchGrid } from "@/components/ui/WorkbenchGrid";
import { OpenInObsidianButton } from "@/components/ui/OpenInObsidianButton";
import { useWorkbenchIndex } from "@/data/adapter";
import { LoadingState, ErrorState } from "./GrowthPage";
import type { WorkbenchIndex } from "@/types";

type AssetGroup = "内容" | "知识" | "原始材料" | "项目" | "待审核";

interface SearchAsset {
  id: string;
  group: AssetGroup;
  title: string;
  type: string;
  summary: string;
  topics: string[];
  status: string;
  updatedAt: string;
  source: string;
  sensitive: boolean;
  pending: boolean;
}

const groupOptions = [
  { value: "内容", label: "内容" },
  { value: "知识", label: "知识" },
  { value: "原始材料", label: "原始材料" },
  { value: "项目", label: "项目" },
];

export function KnowledgePage() {
  const { data, loading, error } = useWorkbenchIndex();
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [includePending, setIncludePending] = useState(false);
  const [selected, setSelected] = useState<SearchAsset | null>(null);

  const assets = useMemo(() => (data ? normalizeAssets(data) : []), [data]);
  const selectedAsset = selected ? assets.find((item) => item.id === selected.id) ?? null : null;

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return assets
      .filter((item) => includePending || !item.pending)
      .filter((item) => !item.sensitive)
      .filter((item) => groupFilter === "" || item.group === groupFilter)
      .filter((item) => {
        if (query === "") return true;
        return [item.title, item.type, item.summary, item.status, ...item.topics]
          .some((value) => value.toLowerCase().includes(query));
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [assets, groupFilter, includePending, search]);

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} />;

  const hasFilter = search || groupFilter || includePending;
  const detail = selectedAsset ? (
    <DetailDrawer title={selectedAsset.title} onClose={() => setSelected(null)}>
      <AssetDetail item={selectedAsset} />
    </DetailDrawer>
  ) : null;

  return (
    <div>
      <ModuleHeader title="资产检索" goal="快速找到可以直接调用的内容、知识与项目资产。" />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          padding: "0 24px 14px",
          flexWrap: "wrap",
          position: "sticky",
          top: "64px",
          zIndex: 40,
          backgroundColor: "var(--color-bg)",
          borderBottom: "1px solid var(--color-border-subtle)",
        }}
      >
        <SearchInput
          value={search}
          onChange={(value) => { setSearch(value); setSelected(null); }}
          placeholder="搜索标题、主题、状态或关键词..."
          label="搜索资产"
        />
        <FilterSelect
          value={groupFilter}
          onChange={(value) => { setGroupFilter(value); setSelected(null); }}
          options={groupOptions}
          placeholder="全部资产"
          label="资产类型"
        />
        <FilterToggle
          checked={includePending}
          onChange={(checked) => { setIncludePending(checked); setSelected(null); }}
          label="含待确认"
        />
        {hasFilter && (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setGroupFilter("");
              setIncludePending(false);
            }}
            style={secondaryButtonStyle}
          >
            清除筛选
          </button>
        )}
      </div>

      <WorkbenchGrid detail={detail} onCloseDetail={() => setSelected(null)}>
        {filtered.length === 0 ? (
          <EmptyState
            title={hasFilter ? "没有匹配的资产" : "暂无可检索资产"}
            description={hasFilter ? "换一个关键词或筛选条件试试。" : "已确认的内容、知识和项目资产会出现在这里。"}
          />
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(290px, 1fr))", gap: "12px" }}>
            {filtered.map((item) => (
              <AssetCard
                key={item.id}
                item={item}
                selected={selectedAsset?.id === item.id}
                onClick={() => setSelected(item)}
              />
            ))}
          </div>
        )}
      </WorkbenchGrid>
    </div>
  );
}

function normalizeAssets(data: WorkbenchIndex): SearchAsset[] {
  const contents: SearchAsset[] = data.contents.map((item) => ({
    id: `content:${item.id}`,
    group: "内容",
    title: item.title,
    type: item.format,
    summary: item.summary,
    topics: item.tags,
    status: item.status,
    updatedAt: item.updatedAt,
    source: item.source,
    sensitive: false,
    pending: false,
  }));

  const knowledge: SearchAsset[] = data.knowledge.map((item) => ({
    id: `knowledge:${item.id}`,
    group: item.type === "原始材料" ? "原始材料" : "知识",
    title: item.title,
    type: item.type,
    summary: item.summary,
    topics: item.topics,
    status: item.confirmation,
    updatedAt: item.updatedAt,
    source: item.source,
    sensitive: item.sensitivity === "敏感",
    pending: item.confirmation === "待人工确认",
  }));

  const projectDocuments: SearchAsset[] = data.projectDocuments.map((item) => ({
    id: `project:${item.id}`,
    group: "项目",
    title: item.title,
    type: item.type,
    summary: item.summary,
    topics: [],
    status: "项目资产",
    updatedAt: item.updatedAt,
    source: item.source,
    sensitive: false,
    pending: false,
  }));

  const evidence: SearchAsset[] = data.evidence.map((item) => ({
    id: `evidence:${item.id}`,
    group: "原始材料",
    title: `${item.platform}账号基线证据`,
    type: "账号证据",
    summary: `${item.platform}账号在 ${item.asOf} 记录为 ${item.value.toLocaleString("zh-CN")} 粉丝。`,
    topics: [item.platform, "粉丝基线"],
    status: "已确认",
    updatedAt: item.asOf,
    source: item.sourceEvidence,
    sensitive: false,
    pending: false,
  }));

  const reviewItems: SearchAsset[] = data.reviewItems.map((item) => ({
    id: `review:${item.id}`,
    group: "待审核",
    title: item.title,
    type: item.type,
    summary: item.summary,
    topics: [],
    status: item.reason,
    updatedAt: item.updatedAt,
    source: item.source,
    sensitive: false,
    pending: item.reason === "待人工确认",
  }));

  return [...contents, ...knowledge, ...evidence, ...projectDocuments, ...reviewItems];
}

function FilterToggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        minHeight: "34px",
        padding: "0 10px",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-md)",
        backgroundColor: checked ? "var(--color-primary-subtle)" : "var(--color-surface)",
        color: checked ? "var(--color-primary)" : "var(--color-text-secondary)",
        fontSize: "var(--text-sm)",
        cursor: "pointer",
      }}
    >
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

function AssetCard({ item, selected, onClick }: { item: SearchAsset; selected: boolean; onClick: () => void }) {
  return (
    <Card onClick={onClick} selected={selected} style={{ padding: "12px 14px" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
            <StatusBadge status={item.group} />
            <span className="truncate" style={{ fontSize: "var(--text-xs)", color: "var(--color-text-secondary)" }}>{item.type}</span>
          </div>
          <span style={{ flexShrink: 0, fontSize: "var(--text-xs)", color: "var(--color-text-tertiary)" }}>
            {item.updatedAt || "—"}
          </span>
        </div>
        <div className="line-clamp-2" style={{ fontWeight: 600, fontSize: "var(--text-md)", lineHeight: 1.45 }}>
          {item.title}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", minHeight: "20px", flexWrap: "wrap" }}>
          {item.status && <StatusBadge status={item.status} />}
          {item.topics.slice(0, 3).map((topic) => (
            <span key={topic} style={{ fontSize: "var(--text-xs)", color: "var(--color-text-tertiary)" }}>{topic}</span>
          ))}
        </div>
      </div>
    </Card>
  );
}

function AssetDetail({ item }: { item: SearchAsset }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <StatusBadge status={item.group} />
        <StatusBadge status={item.type} />
        {item.status && <StatusBadge status={item.status} />}
      </div>
      <Section title="摘要">{item.summary || "暂无摘要"}</Section>
      {item.topics.length > 0 && <Section title="主题">{item.topics.join("、")}</Section>}
      <Section title="更新于">{item.updatedAt || "未记录"}</Section>
      <OpenInObsidianButton source={item.source} primary />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
      <div style={{ fontSize: "var(--text-xs)", color: "var(--color-text-tertiary)", fontWeight: 500 }}>{title}</div>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--color-text-primary)", lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}

const secondaryButtonStyle: React.CSSProperties = {
  padding: "8px 12px",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-md)",
  backgroundColor: "var(--color-surface)",
  color: "var(--color-text-secondary)",
  fontSize: "var(--text-sm)",
  cursor: "pointer",
};
