import { useMemo, useState } from "react";
import { Plus } from "phosphor-react";
import { ModuleHeader } from "@/components/ui/ModuleHeader";
import { SearchInput } from "@/components/ui/SearchInput";
import { FilterSelect } from "@/components/ui/FilterSelect";
import { ViewToggle } from "@/components/ui/ViewToggle";
import { Card } from "@/components/ui/Card";
import { StatusBadge } from "@/components/ui/Badge";
import { DetailDrawer } from "@/components/ui/DetailDrawer";
import { EmptyState } from "@/components/ui/EmptyState";
import { WorkbenchGrid } from "@/components/ui/WorkbenchGrid";
import { useWorkbenchIndex, getLocalContents, saveLocalContents } from "@/data/adapter";
import { LoadingState, ErrorState } from "./GrowthPage";
import type { TopicItem, ViewMode, ContentItem } from "@/types";

const platformOptions = [
  { value: "小红书", label: "小红书" },
  { value: "公众号", label: "公众号" },
  { value: "B 站", label: "B 站" },
  { value: "抖音", label: "抖音" },
  { value: "视频号", label: "视频号" },
];

const sourceOptions = [
  { value: "外部案例", label: "外部案例" },
  { value: "自有案例", label: "自有案例" },
];

const formatOptions = [
  { value: "文章", label: "文章" },
  { value: "短视频口播", label: "短视频口播" },
  { value: "图文卡片", label: "图文卡片" },
];

function mapContentToTopic(contents: NonNullable<ReturnType<typeof useWorkbenchIndex>["data"]>["contents"]): TopicItem[] {
  return contents.map((c) => ({
    id: c.id,
    title: c.title,
    summary: c.summary,
    source: "自有案例",
    platform: c.channels[0] || "多平台",
    theme: c.tags[0] || "主题待确认",
    format: c.format,
    evidenceGap: "派生提示：已发布，待补齐后台数据与复盘",
    originalUrl: null,
    tags: c.tags,
    updatedAt: c.updatedAt,
  }));
}

export function TopicsPage() {
  const { data, loading, error } = useWorkbenchIndex();
  const ownTopics: TopicItem[] = data ? mapContentToTopic(data.contents) : [];
  const externalTopics: TopicItem[] = []; // 外部案例当前为空，等待补充真实对标

  const [search, setSearch] = useState("");
  const [platformFilter, setPlatformFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [formatFilter, setFormatFilter] = useState("");
  const [view, setView] = useState<ViewMode>("card");
  const [selected, setSelected] = useState<TopicItem | null>(null);

  const allTopics = useMemo(() => [...ownTopics, ...externalTopics], [ownTopics, externalTopics]);

  const filtered = useMemo(() => {
    return allTopics.filter((item) => {
      const matchesSearch =
        search.trim() === "" ||
        item.title.toLowerCase().includes(search.toLowerCase()) ||
        item.theme.toLowerCase().includes(search.toLowerCase()) ||
        item.tags.some((t) => t.toLowerCase().includes(search.toLowerCase()));
      const matchesPlatform = platformFilter === "" || item.platform === platformFilter;
      const matchesSource = sourceFilter === "" || item.source === sourceFilter;
      const matchesFormat = formatFilter === "" || item.format === formatFilter;
      return matchesSearch && matchesPlatform && matchesSource && matchesFormat;
    });
  }, [allTopics, search, platformFilter, sourceFilter, formatFilter]);

  const hasFilter = search || platformFilter || sourceFilter || formatFilter;

  const addToContentPlan = (item: TopicItem) => {
    const locals = getLocalContents();
    const newContent: ContentItem = {
      id: `local-content-${Date.now()}`,
      familyId: `local-family-${Date.now()}`,
      title: item.title,
      summary: item.summary,
      status: "候选选题",
      format: item.format,
      channels: item.platform === "多平台" ? [] : [item.platform],
      priority: null,
      dueAt: null,
      source: "驾驶舱新增",
      nextAction: "规划内容角度",
      evidenceStatus: "待补充",
      tags: [...item.tags, "草稿"],
      updatedAt: new Date().toISOString().slice(0, 10),
    };
    saveLocalContents([newContent, ...locals]);
  };

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} />;

  const detail = selected ? (
    <DetailDrawer title={selected.title} onClose={() => setSelected(null)}>
      <TopicDetail item={selected} onAddToPlan={() => addToContentPlan(selected)} />
    </DetailDrawer>
  ) : null;

  return (
    <div>
      <ModuleHeader title="选题爆款 Lab" goal="外部案例与自有选题对比，看清证据缺口。" />

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
        <SearchInput value={search} onChange={setSearch} placeholder="搜索选题或主题..." />
        <FilterSelect value={platformFilter} onChange={setPlatformFilter} options={platformOptions} placeholder="平台" />
        <FilterSelect value={sourceFilter} onChange={setSourceFilter} options={sourceOptions} placeholder="来源" />
        <FilterSelect value={formatFilter} onChange={setFormatFilter} options={formatOptions} placeholder="形式" />
        {hasFilter && (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setPlatformFilter("");
              setSourceFilter("");
              setFormatFilter("");
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
        <div style={{ marginLeft: "auto" }}>
          <ViewToggle value={view} onChange={setView} allowed={["card", "table"]} />
        </div>
      </div>

      <WorkbenchGrid detail={detail} onCloseDetail={() => setSelected(null)}>
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          <section>
            <div
              style={{
                fontSize: "var(--text-md)",
                fontWeight: 600,
                marginBottom: "12px",
                display: "flex",
                alignItems: "center",
                gap: "8px",
              }}
            >
              <span>外部案例</span>
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--color-text-tertiary)",
                  backgroundColor: "var(--color-surface)",
                  padding: "2px 8px",
                  borderRadius: "var(--radius-sm)",
                }}
              >
                0
              </span>
            </div>
            <EmptyState
              title="暂无外部案例"
              description="等待补充真实对标案例。可从小红书、公众号、B 站等平台的爆款内容中收集。"
              icon="warning"
            />
          </section>

          <section>
            <div
              style={{
                fontSize: "var(--text-md)",
                fontWeight: 600,
                marginBottom: "12px",
                display: "flex",
                alignItems: "center",
                gap: "8px",
              }}
            >
              <span>自有案例</span>
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--color-text-tertiary)",
                  backgroundColor: "var(--color-surface)",
                  padding: "2px 8px",
                  borderRadius: "var(--radius-sm)",
                }}
              >
                {ownTopics.length}
              </span>
            </div>
            {filtered.filter((t) => t.source === "自有案例").length === 0 ? (
              <EmptyState title="无匹配自有案例" description="尝试调整搜索或筛选条件。" />
            ) : view === "card" ? (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                  gap: "12px",
                }}
              >
                {filtered
                  .filter((t) => t.source === "自有案例")
                  .map((item) => (
                    <TopicCard
                      key={item.id}
                      item={item}
                      selected={selected?.id === item.id}
                      onClick={() => setSelected(item)}
                    />
                  ))}
              </div>
            ) : (
              <TopicTable
                items={filtered.filter((t) => t.source === "自有案例")}
                selected={selected}
                onSelect={setSelected}
              />
            )}
          </section>
        </div>
      </WorkbenchGrid>
    </div>
  );
}

function TopicCard({
  item,
  selected,
  onClick,
}: {
  item: TopicItem;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <Card onClick={onClick} selected={selected}>
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <StatusBadge status={item.source} />
          <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-tertiary)" }}>{item.platform} · {item.format}</span>
        </div>
        <div style={{ fontWeight: 600, fontSize: "var(--text-md)" }} className="line-clamp-2">
          {item.title}
        </div>
        <div style={{ fontSize: "var(--text-xs)", color: "var(--color-text-tertiary)" }}>
          证据缺口：{item.evidenceGap}
        </div>
      </div>
    </Card>
  );
}

function TopicTable({
  items,
  selected,
  onSelect,
}: {
  items: TopicItem[];
  selected: TopicItem | null;
  onSelect: (item: TopicItem) => void;
}) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--text-sm)" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--color-border)" }}>
            <th style={{ textAlign: "left", padding: "10px 8px" }}>标题</th>
            <th style={{ textAlign: "left", padding: "10px 8px" }}>来源</th>
            <th style={{ textAlign: "left", padding: "10px 8px" }}>平台</th>
            <th style={{ textAlign: "left", padding: "10px 8px" }}>主题</th>
            <th style={{ textAlign: "left", padding: "10px 8px" }}>形式</th>
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
                </button>
              </td>
              <td style={{ padding: "10px 8px" }}><StatusBadge status={item.source} /></td>
              <td style={{ padding: "10px 8px" }}>{item.platform}</td>
              <td style={{ padding: "10px 8px" }}>{item.theme}</td>
              <td style={{ padding: "10px 8px" }}>{item.format}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TopicDetail({ item, onAddToPlan }: { item: TopicItem; onAddToPlan: () => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <StatusBadge status={item.source} />
        <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-tertiary)" }}>{item.platform} · {item.format}</span>
      </div>
      <Section title="主题">{item.theme}</Section>
      <Section title="证据缺口">{item.evidenceGap}</Section>
      {item.originalUrl && (
        <Section title="来源链接">
          <a href={item.originalUrl} target="_blank" rel="noreferrer">{item.originalUrl}</a>
        </Section>
      )}
      <Section title="标签">{item.tags.join("、")}</Section>
      <Section title="更新于">{item.updatedAt}</Section>
      {item.source === "自有案例" && (
        <button
          type="button"
          onClick={onAddToPlan}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "6px",
            padding: "10px",
            border: "none",
            borderRadius: "var(--radius-md)",
            backgroundColor: "var(--color-primary)",
            color: "var(--color-text-inverse)",
            fontWeight: 500,
          }}
        >
          <Plus size={16} />
          加入内容计划
        </button>
      )}
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
