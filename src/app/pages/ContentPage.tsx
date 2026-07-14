import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarBlank, Check, Plus } from "phosphor-react";
import { ModuleHeader } from "@/components/ui/ModuleHeader";
import { SearchInput } from "@/components/ui/SearchInput";
import { FilterSelect } from "@/components/ui/FilterSelect";
import { ViewToggle } from "@/components/ui/ViewToggle";
import { Card } from "@/components/ui/Card";
import { StatusBadge } from "@/components/ui/Badge";
import { DetailDrawer } from "@/components/ui/DetailDrawer";
import { EmptyState } from "@/components/ui/EmptyState";
import { WorkbenchGrid } from "@/components/ui/WorkbenchGrid";
import { OpenInObsidianButton } from "@/components/ui/OpenInObsidianButton";
import { useWorkbenchIndex } from "@/data/adapter";
import { newClientRequestId } from "@/data/clientRequestId";
import {
  ContentAssetsApiError,
  ContentAssetsConflictError,
  createContentAsset,
  getContentAssets,
  markContentAssetComplete,
  registerContentPublication,
  updateContentAsset,
  type ContentAssetSnapshot,
  type ContentPublicationRecord,
  type RegisterContentPublicationInput,
} from "@/data/contentAssetsClient";
import { LoadingState, ErrorState } from "./GrowthPage";
import type { ContentFormat, ContentItem, ContentStatus, ViewMode } from "@/types";
import { useVaultSync } from "@/hooks/useVaultSync";

const PIPELINE: ContentStatus[] = [
  "候选选题",
  "已立项",
  "待发布",
  "已发布",
  "待复盘",
  "已归档",
];

const PHASES: Array<{ key: string; label: string; description: string; emptyLabel: string; statuses: ContentStatus[] }> = [
  { key: "idea", label: "选题", description: "候选选题 · 已立项", emptyLabel: "还没有选题", statuses: ["候选选题", "已立项"] },
  { key: "publish", label: "发布", description: "待发布 · 待核验 · 已发布", emptyLabel: "暂无待发布内容", statuses: ["待发布", "已发布"] },
  { key: "learn", label: "复盘", description: "待复盘", emptyLabel: "暂无待复盘内容", statuses: ["待复盘"] },
];

const FORMAT_OPTIONS: Array<{ value: ContentFormat; label: string }> = [
  { value: "文章", label: "文章" },
  { value: "短视频口播", label: "短视频" },
  { value: "图文卡片", label: "图文卡片" },
  { value: "直播稿", label: "直播稿" },
  { value: "系列", label: "系列" },
];

const STATUS_OPTIONS = PIPELINE.map((status) => ({
  value: status,
  label: status === "已发布"
    ? "已发布（需证据核验）"
    : status === "已归档" ? "已归档（可恢复）" : status,
}));
const MANUAL_STATUS_OPTIONS = STATUS_OPTIONS.filter((option) => ["候选选题", "已立项", "待发布"].includes(option.value));
const PLATFORM_OPTIONS = ["公众号", "小红书", "抖音", "视频号", "B 站", "X"];

function apiMessage(error: unknown) {
  if (error instanceof ContentAssetsApiError) return error.message;
  return "内容暂时无法保存，请稍后重试";
}

function displayContentStatus(item: ContentItem) {
  return ["已发布", "待复盘"].includes(item.status) && item.evidenceStatus !== "有证据" ? "待核验" : item.status;
}

export function ContentPage() {
  const { data, loading, error, refresh } = useWorkbenchIndex();
  const [snapshots, setSnapshots] = useState<ContentAssetSnapshot[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [formatFilter, setFormatFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [platformFilter, setPlatformFilter] = useState("");
  const [view, setView] = useState<ViewMode>("board");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const createRequestRef = useRef<string | null>(null);

  const loadSnapshots = useCallback(async () => {
    try {
      const result = await getContentAssets();
      setSnapshots(result.items);
      setLoadError(null);
    } catch (caught) {
      setLoadError(apiMessage(caught));
    }
  }, []);

  useEffect(() => {
    void loadSnapshots();
  }, [loadSnapshots]);

  useVaultSync(["content-assets"], loadSnapshots);

  const items = useMemo<ContentItem[]>(() => {
    const indexed = new Map((data?.contents ?? []).map((item) => [item.id, item]));
    if (snapshots.length === 0) return data?.contents ?? [];
    return snapshots.map((snapshot) => {
      const source = indexed.get(snapshot.id);
      return {
        id: snapshot.id,
        familyId: source?.familyId ?? snapshot.id,
        title: snapshot.title,
        summary: source?.summary ?? "",
        status: snapshot.status,
        format: snapshot.format,
        channels: snapshot.channels,
        priority: snapshot.priority,
        dueAt: snapshot.dueAt,
        source: source?.source ?? "",
        nextAction: snapshot.nextAction,
        evidenceStatus: source?.evidenceStatus ?? "待补充",
        tags: source?.tags ?? [],
        updatedAt: snapshot.updatedAt,
      };
    });
  }, [data?.contents, snapshots]);

  const isArchiveView = statusFilter === "已归档";
  const activeItems = useMemo(() => items.filter((item) => item.status !== "已归档"), [items]);
  const visibleItems = useMemo(
    () => isArchiveView ? items.filter((item) => item.status === "已归档") : activeItems,
    [activeItems, isArchiveView, items],
  );

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return visibleItems.filter((item) => {
      const matchesKeyword = !keyword
        || item.title.toLowerCase().includes(keyword)
        || item.tags.some((tag) => tag.toLowerCase().includes(keyword));
      return matchesKeyword
        && (!formatFilter || item.format === formatFilter)
        && (!statusFilter || item.status === statusFilter)
        && (!platformFilter || item.channels.includes(platformFilter));
    });
  }, [visibleItems, search, formatFilter, statusFilter, platformFilter]);

  const selected = items.find((item) => item.id === selectedId) ?? null;
  const selectedSnapshot = snapshots.find((item) => item.id === selectedId) ?? null;
  const hasFilter = Boolean(search || formatFilter || statusFilter || platformFilter);

  const saveItem = async (
    item: ContentItem,
    patch: Partial<Pick<ContentAssetSnapshot, "status" | "format" | "channels" | "priority" | "dueAt" | "nextAction">>,
  ) => {
    const current = snapshots.find((snapshot) => snapshot.id === item.id);
    if (!current) return false;
    setSaving(true);
    setSyncError(null);
    try {
      const saved = await updateContentAsset(item.id, patch, current.hash);
      setSnapshots((list) => list.map((row) => row.id === saved.id ? saved : row));
      try {
        await refresh();
      } catch {
        setSyncError("内容已保存，页面摘要暂未刷新");
      }
      return true;
    } catch (caught) {
      if (caught instanceof ContentAssetsConflictError) {
        setSnapshots((list) => list.map((row) => row.id === caught.snapshot.id ? caught.snapshot : row));
      }
      setSyncError(apiMessage(caught));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const runContentAction = async (
    item: ContentItem,
    action: (current: ContentAssetSnapshot) => Promise<ContentAssetSnapshot>,
  ) => {
    const current = snapshots.find((snapshot) => snapshot.id === item.id);
    if (!current) return false;
    setSaving(true);
    setSyncError(null);
    try {
      const saved = await action(current);
      setSnapshots((list) => list.map((row) => row.id === saved.id ? saved : row));
      try {
        await refresh();
      } catch {
        setSyncError("内容已保存，行动目标暂未刷新");
      }
      return true;
    } catch (caught) {
      if (caught instanceof ContentAssetsConflictError) {
        setSnapshots((list) => list.map((row) => row.id === caught.snapshot.id ? caught.snapshot : row));
      }
      setSyncError(apiMessage(caught));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const addItem = async (draft: CreateDraft) => {
    setSaving(true);
    setSyncError(null);
    try {
      createRequestRef.current ??= newClientRequestId();
      const created = await createContentAsset(draft, createRequestRef.current);
      createRequestRef.current = null;
      setSnapshots((list) => [created, ...list.filter((row) => row.id !== created.id)]);
      setShowAdd(false);
      setSelectedId(created.id);
      try {
        await refresh();
      } catch {
        setSyncError("选题已保存，页面摘要暂未刷新");
      }
      return true;
    } catch (caught) {
      if (caught instanceof ContentAssetsConflictError) {
        createRequestRef.current = null;
        setSnapshots((list) => [caught.snapshot, ...list.filter((row) => row.id !== caught.snapshot.id)]);
        setShowAdd(false);
        setSelectedId(caught.snapshot.id);
        setSyncError("已找回首次保存的选题；重试前修改的内容未保存，请核对原记录");
      } else {
        setSyncError(apiMessage(caught));
      }
      return false;
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingState />;
  if (error && !data) return <ErrorState message={error} />;

  const detail = selected && selectedSnapshot ? (
    <DetailDrawer key={`edit:${selected.id}`} title={selected.title} onClose={() => setSelectedId(null)}>
      <EditContentForm
        item={selected}
        snapshot={selectedSnapshot}
        disabled={saving}
        onSave={(patch) => saveItem(selected, patch)}
        onMarkComplete={() => runContentAction(
          selected,
          (current) => markContentAssetComplete(selected.id, current.hash),
        )}
        onRegisterPublication={(input) => runContentAction(
          selected,
          (current) => registerContentPublication(selected.id, current.hash, input),
        )}
        onRestore={async (status) => {
          const restored = await saveItem(selected, { status });
          if (restored && isArchiveView) setSelectedId(null);
          return restored;
        }}
      />
    </DetailDrawer>
  ) : showAdd ? (
    <DetailDrawer key="add-content" title="新建选题" onClose={() => { setShowAdd(false); createRequestRef.current = null; }}>
      <AddContentForm disabled={saving} onSubmit={addItem} />
    </DetailDrawer>
  ) : null;

  return (
    <div>
      <ModuleHeader title="内容工作台" goal="从选题到复盘，只看每份内容现在在哪一步、下一步做什么。" />

      <div className="workbench-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="搜索标题或主题…" />
        <FilterSelect value={formatFilter} onChange={setFormatFilter} options={FORMAT_OPTIONS} placeholder="内容形态" />
        <FilterSelect value={platformFilter} onChange={setPlatformFilter} options={PLATFORM_OPTIONS.map((platform) => ({ value: platform, label: platform }))} placeholder="发布平台" />
        <FilterSelect value={statusFilter} onChange={setStatusFilter} options={STATUS_OPTIONS} placeholder="当前状态" />
        {hasFilter ? (
          <button type="button" className="quiet-button" onClick={() => { setSearch(""); setFormatFilter(""); setStatusFilter(""); setPlatformFilter(""); }}>
            清除筛选
          </button>
        ) : null}
        <div className="toolbar-actions">
          {!isArchiveView ? <ViewToggle value={view} onChange={setView} allowed={["board", "table"]} /> : null}
          <button type="button" className="primary-button" onClick={() => {
            setSelectedId(null);
            createRequestRef.current = newClientRequestId();
            setShowAdd(true);
          }}>
            <Plus size={16} weight="bold" />
            新建选题
          </button>
        </div>
      </div>

      <WorkbenchGrid detail={detail} onCloseDetail={() => { setSelectedId(null); setShowAdd(false); createRequestRef.current = null; }}>
        {!isArchiveView ? <PipelineSummary items={activeItems} /> : null}
        {syncError || loadError ? <div className="inline-error" role="alert">{syncError ?? loadError}</div> : null}
        {isArchiveView ? (
          <ArchivedContentView items={filtered} selectedId={selectedId} onSelect={(id) => { setShowAdd(false); setSelectedId(id); }} />
        ) : filtered.length === 0 ? (
          <EmptyState title="这里还没有内容" description={hasFilter ? "换个筛选条件试试。" : "先记下一个值得验证的选题。"} />
        ) : view === "board" ? (
          <PhaseBoard items={filtered} selectedId={selectedId} onSelect={(id) => { setShowAdd(false); setSelectedId(id); }} />
        ) : (
          <ContentTable items={filtered} selectedId={selectedId} onSelect={(id) => { setShowAdd(false); setSelectedId(id); }} />
        )}
      </WorkbenchGrid>
    </div>
  );
}

function ArchivedContentView({ items, selectedId, onSelect }: {
  items: ContentItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="archive-view" aria-labelledby="archive-view-title">
      <div className="archive-view-heading">
        <div>
          <h2 id="archive-view-title">归档内容</h2>
          <p>这里的内容没有被删除，可以随时恢复。</p>
        </div>
        <strong>{items.length}</strong>
      </div>
      {items.length ? (
        <ContentTable items={items} selectedId={selectedId} onSelect={onSelect} />
      ) : (
        <EmptyState title="归档中没有内容" description="移入归档的内容会显示在这里。" />
      )}
    </section>
  );
}

function PipelineSummary({ items }: { items: ContentItem[] }) {
  return (
    <div className="pipeline-summary" aria-label="内容流水线摘要">
      {PHASES.map((phase) => (
        <div key={phase.key} className="pipeline-summary-item">
          <span>{phase.label}</span>
          <strong>{items.filter((item) => phase.statuses.includes(item.status)).length}</strong>
        </div>
      ))}
    </div>
  );
}

function PhaseBoard({ items, selectedId, onSelect }: { items: ContentItem[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="content-phase-board" aria-label="内容工作流看板">
      {PHASES.map((phase) => {
        const phaseItems = items.filter((item) => phase.statuses.includes(item.status));
        return (
          <section key={phase.key} className="content-phase-column" aria-labelledby={`phase-${phase.key}`}>
            <div className="phase-heading">
              <div>
                <h2 id={`phase-${phase.key}`}>{phase.label}</h2>
                <span>{phase.description}</span>
              </div>
              <strong>{phaseItems.length}</strong>
            </div>
            <div className="phase-card-list">
              {phaseItems.length ? phaseItems.map((item) => (
                <ContentCard key={item.id} item={item} selected={selectedId === item.id} onClick={() => onSelect(item.id)} />
              )) : <div className="phase-empty">{phase.emptyLabel}</div>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ContentCard({ item, selected, onClick }: { item: ContentItem; selected: boolean; onClick: () => void }) {
  return (
    <Card onClick={onClick} selected={selected}>
      <div className="content-card-compact">
        <div className="content-card-meta">
          <StatusBadge status={displayContentStatus(item)} />
          <span>{item.format === "短视频口播" ? "短视频" : item.format}</span>
        </div>
        <h3>{item.title}</h3>
        <div className="content-card-platforms">{item.channels.length ? item.channels.join(" · ") : "平台待定"}</div>
        <div className="content-card-next">下一步：{item.nextAction || "待安排"}</div>
        {item.dueAt ? <div className="content-card-date"><CalendarBlank size={13} />{item.dueAt}</div> : null}
      </div>
    </Card>
  );
}

function ContentTable({ items, selectedId, onSelect }: { items: ContentItem[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="dense-table-wrap">
      <table className="dense-table">
        <thead><tr><th>内容</th><th>状态</th><th>形态</th><th>平台</th><th>下一步</th><th>截止日期</th></tr></thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className={selectedId === item.id ? "is-selected" : ""}>
              <td><button type="button" onClick={() => onSelect(item.id)}>{item.title}</button></td>
              <td><StatusBadge status={displayContentStatus(item)} /></td>
              <td>{item.format === "短视频口播" ? "短视频" : item.format}</td>
              <td>{item.channels.join("、") || "待定"}</td>
              <td>{item.nextAction || "待安排"}</td>
              <td>{item.dueAt || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type CreateDraft = {
  title: string;
  summary: string;
  status: ContentStatus;
  format: ContentFormat;
  channels: string[];
  priority: ContentItem["priority"];
  dueAt: string | null;
  nextAction: string;
};

function useImeSafeForm() {
  const composing = useRef(false);
  return {
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: () => { composing.current = false; },
    onKeyDown: (event: React.KeyboardEvent<HTMLFormElement>) => {
      if (
        event.key === "Enter"
        && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)
      ) {
        event.preventDefault();
      }
    },
  };
}

function AddContentForm({ disabled, onSubmit }: { disabled: boolean; onSubmit: (draft: CreateDraft) => Promise<boolean> }) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [format, setFormat] = useState<ContentFormat>("文章");
  const [channels, setChannels] = useState<string[]>(["公众号"]);
  const [nextAction, setNextAction] = useState("完成选题判断");
  const [dueAt, setDueAt] = useState("");
  const imeSafeForm = useImeSafeForm();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    await onSubmit({
      title: title.trim(),
      summary: summary.trim(),
      status: "候选选题",
      format,
      channels,
      priority: null,
      dueAt: dueAt || null,
      nextAction: nextAction.trim() || "完成选题判断",
    });
  };

  return (
    <form className="content-editor-form" onSubmit={submit} {...imeSafeForm}>
      <Field label="标题"><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} required /></Field>
      <Field label="内容形态"><select value={format} onChange={(event) => setFormat(event.target.value as ContentFormat)}>{FORMAT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field>
      <Field label="发布平台"><PlatformPicker value={channels} onChange={setChannels} /></Field>
      <Field label="下一步"><input value={nextAction} onChange={(event) => setNextAction(event.target.value)} maxLength={160} /></Field>
      <Field label="计划完成"><input type="date" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></Field>
      <Field label="一句话说明（可选）"><textarea value={summary} onChange={(event) => setSummary(event.target.value)} rows={3} maxLength={300} /></Field>
      <button type="submit" className="primary-button full-width" disabled={disabled || !title.trim()}>{disabled ? "保存中…" : "保存选题"}</button>
    </form>
  );
}

function EditContentForm({ item, snapshot, disabled, onSave, onMarkComplete, onRegisterPublication, onRestore }: {
  item: ContentItem;
  snapshot: ContentAssetSnapshot;
  disabled: boolean;
  onSave: (patch: Partial<Pick<ContentAssetSnapshot, "status" | "format" | "channels" | "priority" | "dueAt" | "nextAction">>) => Promise<boolean>;
  onMarkComplete: () => Promise<boolean>;
  onRegisterPublication: (input: RegisterContentPublicationInput) => Promise<boolean>;
  onRestore: (status: ContentStatus) => Promise<boolean>;
}) {
  const [status, setStatus] = useState(item.status);
  const [format, setFormat] = useState(item.format);
  const [channels, setChannels] = useState(item.channels);
  const [nextAction, setNextAction] = useState(item.nextAction);
  const [dueAt, setDueAt] = useState(item.dueAt ?? "");
  const [saved, setSaved] = useState(false);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const imeSafeForm = useImeSafeForm();

  useEffect(() => {
    setStatus(item.status);
    setFormat(item.format);
    setChannels(item.channels);
    setNextAction(item.nextAction);
    setDueAt(item.dueAt ?? "");
    setSaved(false);
    setConfirmingArchive(false);
  }, [item]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const patch: Partial<Pick<ContentAssetSnapshot, "status" | "format" | "channels" | "dueAt" | "nextAction">> = {};
    if (status !== item.status) patch.status = status;
    if (format !== item.format) patch.format = format;
    if (JSON.stringify(channels) !== JSON.stringify(item.channels)) patch.channels = channels;
    if (nextAction.trim() !== item.nextAction) patch.nextAction = nextAction.trim();
    if ((dueAt || null) !== item.dueAt) patch.dueAt = dueAt || null;
    if (Object.keys(patch).length === 0) {
      setSaved(true);
      return;
    }
    const ok = await onSave(patch);
    setSaved(ok);
  };

  const archive = async () => {
    const ok = await onSave({ status: "已归档" });
    if (ok) setConfirmingArchive(false);
  };

  const restoreStatus: ContentStatus = item.evidenceStatus === "有证据" ? "待复盘" : "候选选题";
  const hasPendingEdits = status !== item.status
    || format !== item.format
    || JSON.stringify(channels) !== JSON.stringify(item.channels)
    || nextAction.trim() !== item.nextAction
    || (dueAt || null) !== item.dueAt;
  const statusIsSystemManaged = ["已发布", "待复盘"].includes(item.status);

  if (item.status === "已归档") {
    return (
      <div className="content-editor-form">
        <div className="drawer-status-row"><StatusBadge status="已归档" /><span>{item.channels.join(" · ") || "平台待定"}</span></div>
        <div className="archive-restore-panel">
          <strong>这份内容已归档</strong>
          <p>恢复后将回到「{restoreStatus}」。原 Markdown 内容和发布证据都会保留。</p>
          <button type="button" className="primary-button full-width" disabled={disabled} onClick={() => onRestore(restoreStatus)}>
            {disabled ? "恢复中…" : "恢复"}
          </button>
        </div>
        {item.source ? <OpenInObsidianButton source={item.source} /> : null}
      </div>
    );
  }

  return (
    <div className="content-editor-form">
      <div className="drawer-status-row"><StatusBadge status={displayContentStatus(item)} /><span>{item.channels.join(" · ") || "平台待定"}</span></div>
      <form className="content-settings-form" onSubmit={submit} {...imeSafeForm}>
        <Field label="当前状态">
          {statusIsSystemManaged ? (
            <div className="content-state-readonly">{item.status} · 由发布与复盘记录自动更新</div>
          ) : (
            <select value={status} onChange={(event) => { setStatus(event.target.value as ContentStatus); setSaved(false); }}>
              {MANUAL_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          )}
        </Field>
        <Field label="内容形态"><select value={format} onChange={(event) => { setFormat(event.target.value as ContentFormat); setSaved(false); }}>{FORMAT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field>
        <Field label="计划发布平台"><PlatformPicker value={channels} onChange={(next) => { setChannels(next); setSaved(false); }} /></Field>
        <Field label="下一步"><input value={nextAction} onChange={(event) => { setNextAction(event.target.value); setSaved(false); }} maxLength={160} /></Field>
        <Field label="计划完成"><input type="date" value={dueAt} onChange={(event) => { setDueAt(event.target.value); setSaved(false); }} /></Field>
        <button type="submit" className="primary-button full-width" disabled={disabled || !hasPendingEdits}>{disabled ? "保存中…" : saved ? <><Check size={16} />已保存</> : "保存修改"}</button>
      </form>

      {["文章", "短视频口播"].includes(item.format) ? (
        <CompletionPanel
          format={item.format}
          completedAt={snapshot.completedAt}
          disabled={disabled || hasPendingEdits}
          hasPendingEdits={hasPendingEdits}
          onComplete={onMarkComplete}
        />
      ) : null}

      <PublicationPanel
        completedAt={snapshot.completedAt}
        publicationRecords={snapshot.publicationRecords}
        preferredPlatforms={item.channels}
        disabled={disabled || hasPendingEdits}
        hasPendingEdits={hasPendingEdits}
        onSubmit={onRegisterPublication}
      />

      {item.source ? <OpenInObsidianButton source={item.source} /> : null}
      <div className="archive-danger-zone" aria-label="归档操作">
        <strong>归档</strong>
        <p>归档后不会删除 Markdown，可以从“已归档”筛选中恢复。</p>
        {confirmingArchive ? (
          <div className="archive-confirm-actions">
            <button type="button" className="danger-button" disabled={disabled} onClick={archive}>
              {disabled ? "处理中…" : "确认移入归档"}
            </button>
            <button type="button" className="quiet-button" disabled={disabled} onClick={() => setConfirmingArchive(false)}>取消</button>
          </div>
        ) : (
          <button type="button" className="danger-button full-width" disabled={disabled} onClick={() => setConfirmingArchive(true)}>移入归档</button>
        )}
      </div>
    </div>
  );
}

function CompletionPanel({ format, completedAt, disabled, hasPendingEdits, onComplete }: {
  format: ContentFormat;
  completedAt: string | null;
  disabled: boolean;
  hasPendingEdits: boolean;
  onComplete: () => Promise<boolean>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const label = format === "短视频口播" ? "短视频" : "文章";
  const complete = async () => {
    const evidenceLabel = format === "短视频口播" ? "短视频已经形成可发布成片" : "文章已经形成可发布成稿";
    if (!window.confirm(`确认${evidenceLabel}，并计入“${label}”行动目标吗？`)) return;
    setSubmitting(true);
    try {
      await onComplete();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="content-action-panel" aria-labelledby="completion-panel-title">
      <div className="content-action-heading">
        <div>
          <h3 id="completion-panel-title">成品确认</h3>
          <p>仅在{label}已形成可发布{format === "短视频口播" ? "成片" : "成稿"}时确认，确认后计入行动目标。</p>
        </div>
        {completedAt ? <span className="action-status is-complete"><Check size={14} />已完成</span> : null}
      </div>
      {completedAt ? (
        <div className="completion-time">完成时间：<time dateTime={completedAt}>{formatShanghaiDateTime(completedAt)}</time></div>
      ) : (
        <button type="button" className="quiet-button full-width" disabled={disabled || submitting} onClick={complete}>
          {submitting ? "记录中…" : `确认${label}已${format === "短视频口播" ? "成片" : "成稿"}`}
        </button>
      )}
      {hasPendingEdits ? <p className="action-inline-note">请先保存上方修改，再记录完成。</p> : null}
    </section>
  );
}

function PublicationPanel({ completedAt, publicationRecords, preferredPlatforms, disabled, hasPendingEdits, onSubmit }: {
  completedAt: string | null;
  publicationRecords: ContentPublicationRecord[];
  preferredPlatforms: string[];
  disabled: boolean;
  hasPendingEdits: boolean;
  onSubmit: (input: RegisterContentPublicationInput) => Promise<boolean>;
}) {
  const [showForm, setShowForm] = useState(false);

  return (
    <section className="content-action-panel" aria-labelledby="publication-panel-title">
      <div className="content-action-heading">
        <div>
          <h3 id="publication-panel-title">发布记录</h3>
          <p>同一内容发布到不同平台时，分别登记。</p>
        </div>
        <span className="action-status">{publicationRecords.length} 次</span>
      </div>

      {publicationRecords.length ? <PublicationRecordList records={publicationRecords} /> : (
        <div className="publication-empty">还没有发布记录</div>
      )}

      {showForm ? (
        <PublicationForm
          completedAt={completedAt}
          preferredPlatforms={preferredPlatforms}
          publicationRecords={publicationRecords}
          disabled={disabled}
          onCancel={() => setShowForm(false)}
          onSubmit={async (input) => {
            const ok = await onSubmit(input);
            if (ok) setShowForm(false);
            return ok;
          }}
        />
      ) : (
        <button type="button" className="primary-button full-width" disabled={disabled} onClick={() => setShowForm(true)}>
          <Plus size={16} weight="bold" />登记发布
        </button>
      )}
      {hasPendingEdits ? <p className="action-inline-note">请先保存上方修改，再登记发布。</p> : null}
    </section>
  );
}

function PublicationRecordList({ records }: { records: ContentPublicationRecord[] }) {
  return (
    <ul className="publication-record-list" aria-label="已有发布记录">
      {records.map((record) => (
        <li key={record.id}>
          <div>
            <strong>{record.platform}</strong>
            <span className={record.verification === "已核验" ? "is-verified" : ""}>{record.verification}</span>
          </div>
          <time dateTime={record.publishedAt ?? undefined}>{record.publishedAt ? formatShanghaiDateTime(record.publishedAt) : "时间待补充"}</time>
          {record.url ? <a href={record.url} target="_blank" rel="noreferrer">打开发布链接</a> : <span>{record.evidenceRef ? "证据已记录" : "证据待补充"}</span>}
        </li>
      ))}
    </ul>
  );
}

function PublicationForm({ completedAt, preferredPlatforms, publicationRecords, disabled, onCancel, onSubmit }: {
  completedAt: string | null;
  preferredPlatforms: string[];
  publicationRecords: ContentPublicationRecord[];
  disabled: boolean;
  onCancel: () => void;
  onSubmit: (input: RegisterContentPublicationInput) => Promise<boolean>;
}) {
  const [platform, setPlatform] = useState(() => preferredPlatforms.find((item) => PLATFORM_OPTIONS.includes(item)) ?? "公众号");
  const [publishedAt, setPublishedAt] = useState(() => shanghaiDateTimeInputValue());
  const [url, setUrl] = useState("");
  const [evidenceRef, setEvidenceRef] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const imeSafeForm = useImeSafeForm();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const cleanUrl = url.trim();
    const cleanEvidenceRef = evidenceRef.trim();
    if (!publishedAt) return setValidation("请选择实际发布时间");
    if (Boolean(cleanUrl) === Boolean(cleanEvidenceRef)) return setValidation("发布链接和 V2 证据引用必须二选一");
    if (cleanUrl && !cleanUrl.startsWith("https://")) return setValidation("发布链接必须以 https:// 开头");
    if (!confirmed) return setValidation("请先确认这条内容已经真实发布");
    const duplicate = publicationRecords.some((record) => (
      cleanUrl ? record.url === cleanUrl : record.evidenceRef === cleanEvidenceRef
    ));
    if (duplicate) return setValidation("这条发布记录已经存在，无需重复登记");

    setValidation(null);
    setSubmitting(true);
    try {
      await onSubmit({
        platform,
        publishedAt: `${publishedAt}:00+08:00`,
        ...(cleanUrl ? { url: cleanUrl } : { evidenceRef: cleanEvidenceRef }),
        confirmed: true,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="publication-form" onSubmit={submit} {...imeSafeForm}>
      {!completedAt ? <div className="publication-auto-complete">登记成功后，这份内容会同时确认已形成可发布成品。</div> : null}
      <Field label="发布平台">
        <select value={platform} onChange={(event) => { setPlatform(event.target.value); setValidation(null); }}>
          {PLATFORM_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </Field>
      <Field label="实际发布时间">
        <input type="datetime-local" step={60} value={publishedAt} onChange={(event) => { setPublishedAt(event.target.value); setValidation(null); }} required />
      </Field>
      <Field label="发布链接（与证据引用二选一）">
        <input type="url" inputMode="url" placeholder="https://…" value={url} onChange={(event) => { setUrl(event.target.value); setValidation(null); }} />
      </Field>
      <div className="publication-divider"><span>或</span></div>
      <Field label="V2 证据引用（与发布链接二选一）">
        <input placeholder="例如：[[2026-07-14-公众号发布截图]]" value={evidenceRef} onChange={(event) => { setEvidenceRef(event.target.value); setValidation(null); }} maxLength={300} />
      </Field>
      <label className="publication-confirm">
        <input type="checkbox" checked={confirmed} onChange={(event) => { setConfirmed(event.target.checked); setValidation(null); }} />
        <span>我确认这条内容已经真实发布，以上信息准确。</span>
      </label>
      {validation ? <div className="form-validation" role="alert">{validation}</div> : null}
      <div className="publication-form-actions">
        <button type="submit" className="primary-button" disabled={disabled || submitting}>{submitting ? "保存中…" : "保存发布记录"}</button>
        <button type="button" className="quiet-button" disabled={disabled || submitting} onClick={onCancel}>取消</button>
      </div>
    </form>
  );
}

function shanghaiDateTimeInputValue(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

function formatShanghaiDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function PlatformPicker({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  return (
    <div className="platform-picker">
      {PLATFORM_OPTIONS.map((platform) => {
        const active = value.includes(platform);
        return (
          <button
            key={platform}
            type="button"
            className={active ? "is-active" : ""}
            aria-pressed={active}
            onClick={() => onChange(active ? value.filter((item) => item !== platform) : [...value, platform])}
          >
            {active ? <Check size={13} weight="bold" /> : <Plus size={13} />}{platform}
          </button>
        );
      })}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="form-field"><span>{label}</span>{children}</label>;
}
