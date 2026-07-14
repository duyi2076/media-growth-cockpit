import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, PencilSimple, Plus } from "phosphor-react";
import { StatusBadge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { DetailDrawer } from "@/components/ui/DetailDrawer";
import { EmptyState } from "@/components/ui/EmptyState";
import { FilterSelect } from "@/components/ui/FilterSelect";
import { ModuleHeader } from "@/components/ui/ModuleHeader";
import { OpenInObsidianButton } from "@/components/ui/OpenInObsidianButton";
import { WorkbenchGrid } from "@/components/ui/WorkbenchGrid";
import { useWorkbenchIndex } from "@/data/adapter";
import { newClientRequestId } from "@/data/clientRequestId";
import {
  DailyReviewsApiError,
  DailyReviewsConflictError,
  createDailyReview,
  getDailyReviews,
  updateDailyReview,
  type CreateDailyReviewInput,
  type DailyReviewConfirmation,
  type DailyReviewSnapshot,
  type UpdateDailyReviewPatch,
} from "@/data/dailyReviewsClient";
import { useVaultSync } from "@/hooks/useVaultSync";
import { LoadingState } from "./GrowthPage";

const confirmationOptions = [
  { value: "待人工确认", label: "待人工确认" },
  { value: "已确认", label: "已确认" },
];

interface DailyReviewDraft {
  date: string;
  todayCompleted: string;
  facts: string;
  effectiveActions: string;
  problems: string;
  judgment: string;
  tomorrowAction: string;
}

function shanghaiToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function emptyDraft(): DailyReviewDraft {
  return {
    date: shanghaiToday(),
    todayCompleted: "",
    facts: "",
    effectiveActions: "",
    problems: "",
    judgment: "",
    tomorrowAction: "",
  };
}

function draftFrom(item: DailyReviewSnapshot): DailyReviewDraft {
  return {
    date: item.date,
    todayCompleted: item.todayCompleted,
    facts: item.facts,
    effectiveActions: item.effectiveActions,
    problems: item.problems,
    judgment: item.judgment,
    tomorrowAction: item.tomorrowAction,
  };
}

function apiMessage(error: unknown): string {
  return error instanceof DailyReviewsApiError ? error.message : "每日复盘暂时无法保存，请稍后重试";
}

function normalizeDraft(draft: DailyReviewDraft): CreateDailyReviewInput {
  return {
    date: draft.date,
    todayCompleted: draft.todayCompleted.trim(),
    facts: draft.facts.trim(),
    effectiveActions: draft.effectiveActions.trim(),
    problems: draft.problems.trim(),
    judgment: draft.judgment.trim(),
    tomorrowAction: draft.tomorrowAction.trim(),
  };
}

function contentPatch(item: DailyReviewSnapshot, draft: DailyReviewDraft): UpdateDailyReviewPatch {
  const next = normalizeDraft(draft);
  const patch: UpdateDailyReviewPatch = {};
  for (const key of ["todayCompleted", "facts", "effectiveActions", "problems", "judgment", "tomorrowAction"] as const) {
    if (next[key] !== item[key]) patch[key] = next[key];
  }
  return patch;
}

function complete(item: Pick<DailyReviewSnapshot, "todayCompleted" | "facts" | "effectiveActions" | "problems" | "judgment" | "tomorrowAction">): boolean {
  return [item.todayCompleted, item.facts, item.effectiveActions, item.problems, item.judgment, item.tomorrowAction]
    .every((value) => value.trim().length > 0);
}

export function DailyReviewsPage() {
  const { refresh } = useWorkbenchIndex();
  const [items, setItems] = useState<DailyReviewSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [confirmationFilter, setConfirmationFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [conflictReloadToken, setConflictReloadToken] = useState(0);
  const createRequestRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await getDailyReviews();
      setItems(result.items);
      setLoadError(null);
    } catch (error) {
      setLoadError(apiMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useVaultSync(["daily-reviews"], load);

  const visibleItems = useMemo(() => items
    .filter((item) => !confirmationFilter || item.confirmation === confirmationFilter)
    .sort((a, b) => b.date.localeCompare(a.date)), [confirmationFilter, items]);
  const selected = items.find((item) => item.id === selectedId) ?? null;

  const syncIndex = async () => {
    try { await refresh(); }
    catch { setSyncError("已保存，目标进度暂未刷新"); }
  };

  const createItem = async (input: CreateDailyReviewInput) => {
    setSaving(true);
    setSyncError(null);
    try {
      createRequestRef.current ??= newClientRequestId();
      const created = await createDailyReview(input, createRequestRef.current);
      createRequestRef.current = null;
      setItems((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      setShowAdd(false);
      setSelectedId(created.id);
      await syncIndex();
      return true;
    } catch (error) {
      if (error instanceof DailyReviewsConflictError) {
        createRequestRef.current = null;
        setItems((current) => [error.snapshot, ...current.filter((item) => item.id !== error.snapshot.id)]);
        setShowAdd(false);
        setSelectedId(error.snapshot.id);
        setConflictReloadToken((value) => value + 1);
        setSyncError("已找回首次保存的每日复盘；重试前修改的内容未保存，请核对后继续编辑");
      } else {
        setSyncError(apiMessage(error));
      }
      return false;
    } finally { setSaving(false); }
  };

  const updateItem = async (id: string, patch: UpdateDailyReviewPatch, expectedHash: string) => {
    setSaving(true);
    setSyncError(null);
    try {
      const saved = await updateDailyReview(id, patch, expectedHash);
      setItems((current) => current.map((item) => item.id === saved.id ? saved : item));
      await syncIndex();
      return saved;
    } catch (error) {
      if (error instanceof DailyReviewsConflictError) {
        setItems((current) => current.map((item) => item.id === error.snapshot.id ? error.snapshot : item));
        setConflictReloadToken((value) => value + 1);
        setSyncError("已载入 Obsidian 中的最新版本，请重新编辑后保存");
      } else setSyncError(apiMessage(error));
      return null;
    } finally { setSaving(false); }
  };

  if (loading) return <LoadingState />;

  const closeDetail = () => {
    setSelectedId(null);
    setShowAdd(false);
    createRequestRef.current = null;
  };
  const detail = selected ? (
    <DetailDrawer key={`daily-review:${selected.id}`} title={`${selected.date} 每日复盘`} onClose={closeDetail}>
      <EditDailyReviewForm
        item={selected}
        disabled={saving}
        conflictReloadToken={conflictReloadToken}
        onSave={(patch, hash) => updateItem(selected.id, patch, hash)}
      />
    </DetailDrawer>
  ) : showAdd ? (
    <DetailDrawer title="新建每日复盘" onClose={closeDetail}>
      <AddDailyReviewForm disabled={saving} onSubmit={createItem} />
    </DetailDrawer>
  ) : null;

  return (
    <div>
      <ModuleHeader title="每日复盘" goal="把今天的结果沉淀成明天最重要的一步。" />
      <div className="workbench-toolbar review-toolbar">
        <FilterSelect
          value={confirmationFilter}
          onChange={setConfirmationFilter}
          options={confirmationOptions}
          placeholder="全部确认状态"
          label="确认状态"
        />
        {confirmationFilter ? <button type="button" className="quiet-button" onClick={() => setConfirmationFilter("")}>清除筛选</button> : null}
        <div className="toolbar-actions">
          <button type="button" className="primary-button" onClick={() => {
            setSelectedId(null);
            createRequestRef.current = newClientRequestId();
            setShowAdd(true);
          }}>
            <Plus size={16} weight="bold" />新建每日复盘
          </button>
        </div>
      </div>
      <WorkbenchGrid detail={detail} onCloseDetail={closeDetail}>
        {syncError || loadError ? <div className="inline-error" role="alert">{syncError ?? loadError}</div> : null}
        {visibleItems.length === 0 ? (
          <EmptyState title="还没有每日复盘" description="先记录今天发生了什么，再留下明天最重要的一步。" />
        ) : (
          <div className="daily-review-grid">
            {visibleItems.map((item) => (
              <DailyReviewCard
                key={item.id}
                item={item}
                selected={item.id === selectedId}
                disabled={saving}
                onOpen={() => { setShowAdd(false); createRequestRef.current = null; setSelectedId(item.id); }}
                onConfirm={() => updateItem(item.id, { confirmation: "已确认" }, item.hash)}
              />
            ))}
          </div>
        )}
      </WorkbenchGrid>
    </div>
  );
}

function DailyReviewCard({ item, selected, disabled, onOpen, onConfirm }: {
  item: DailyReviewSnapshot;
  selected: boolean;
  disabled: boolean;
  onOpen: () => void;
  onConfirm: () => Promise<DailyReviewSnapshot | null>;
}) {
  return (
    <Card onClick={onOpen} selected={selected} ariaLabel={`编辑每日复盘：${item.date}`} style={{ padding: "14px 16px" }}>
      <div className="daily-review-card">
        <div className="review-card-meta">
          <div className="daily-review-date"><time dateTime={item.date}>{item.date}</time><StatusBadge status={item.confirmation} /></div>
          <div className="review-card-meta-actions">
            {item.confirmation === "待人工确认" ? (
              <button
                type="button"
                className="review-card-confirm"
                disabled={disabled}
                onClick={(event) => { event.stopPropagation(); void onConfirm(); }}
                onKeyDown={(event) => event.stopPropagation()}
                aria-label={`确认每日复盘：${item.date}`}
              ><Check size={13} aria-hidden="true" />确认</button>
            ) : null}
            <span className="review-card-edit-hint"><PencilSimple size={13} aria-hidden="true" />编辑</span>
          </div>
        </div>
        <div className="daily-review-card-row"><span>今日判断</span><p>{item.judgment || "待填写"}</p></div>
        <div className="daily-review-card-row is-next"><span>明日动作</span><p>{item.tomorrowAction || "待填写"}</p></div>
      </div>
    </Card>
  );
}

function AddDailyReviewForm({ disabled, onSubmit }: {
  disabled: boolean;
  onSubmit: (input: CreateDailyReviewInput) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<DailyReviewDraft>(emptyDraft);
  const [validation, setValidation] = useState<string | null>(null);
  const composing = useRef(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (composing.current) return;
    if (!draft.date) { setValidation("请选择复盘日期"); return; }
    setValidation(null);
    await onSubmit(normalizeDraft(draft));
  };
  return (
    <form className="content-editor-form" onSubmit={submit} {...compositionGuard(composing)}>
      <Field label="日期"><input type="date" value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })} required disabled={disabled} /></Field>
      <DailyReviewFields draft={draft} setDraft={setDraft} disabled={disabled} />
      {validation ? <div className="form-validation" role="alert">{validation}</div> : null}
      <button type="submit" className="primary-button full-width" disabled={disabled || !draft.date}>{disabled ? "保存中…" : "保存草稿"}</button>
    </form>
  );
}

function EditDailyReviewForm({ item, disabled, conflictReloadToken, onSave }: {
  item: DailyReviewSnapshot;
  disabled: boolean;
  conflictReloadToken: number;
  onSave: (patch: UpdateDailyReviewPatch, hash: string) => Promise<DailyReviewSnapshot | null>;
}) {
  const [draft, setDraft] = useState<DailyReviewDraft>(() => draftFrom(item));
  const [baseHash, setBaseHash] = useState(item.hash);
  const [dirty, setDirty] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const composing = useRef(false);

  useEffect(() => {
    setDraft(draftFrom(item));
    setBaseHash(item.hash);
    setDirty(false);
    setValidation(null);
    setSaved(false);
  }, [item.id, conflictReloadToken]);

  useEffect(() => {
    if (dirty || item.hash === baseHash) return;
    setDraft(draftFrom(item));
    setBaseHash(item.hash);
  }, [baseHash, dirty, item]);

  const persist = async (confirmation?: DailyReviewConfirmation) => {
    const patch = contentPatch(item, draft);
    if (confirmation) patch.confirmation = confirmation;
    const candidate = { ...item, ...normalizeDraft(draft), confirmation: confirmation ?? item.confirmation };
    if (confirmation === "已确认" && !complete(candidate)) {
      setValidation("确认前请把六个复盘字段填写完整");
      return;
    }
    setValidation(null);
    if (Object.keys(patch).length === 0) { setSaved(true); setDirty(false); return; }
    const result = await onSave(patch, baseHash);
    if (!result) return;
    setDraft(draftFrom(result));
    setBaseHash(result.hash);
    setDirty(false);
    setSaved(true);
  };

  return (
    <form className="content-editor-form" onSubmit={(event) => { event.preventDefault(); if (!composing.current) void persist(); }} {...compositionGuard(composing)}>
      <div className="drawer-status-row"><StatusBadge status={item.confirmation} /><span>{item.date}</span></div>
      <DailyReviewFields draft={draft} setDraft={(next) => { setDraft(next); setDirty(true); setSaved(false); }} disabled={disabled} />
      {validation ? <div className="form-validation" role="alert">{validation}</div> : null}
      <button type="submit" className="primary-button full-width" disabled={disabled}>
        {disabled ? "保存中…" : saved ? <><Check size={16} />已保存</> : item.confirmation === "已确认" ? "保存修改（需重新确认）" : "保存修改"}
      </button>
      {item.confirmation === "待人工确认" ? (
        <button type="button" className="quiet-button full-width" disabled={disabled} onClick={() => void persist("已确认")}>确认并保存</button>
      ) : null}
      <OpenInObsidianButton source={item.source} />
    </form>
  );
}

function DailyReviewFields({ draft, setDraft, disabled }: {
  draft: DailyReviewDraft;
  setDraft: (draft: DailyReviewDraft) => void;
  disabled: boolean;
}) {
  const update = (key: keyof Omit<DailyReviewDraft, "date">, value: string) => setDraft({ ...draft, [key]: value });
  return (
    <>
      <Field label="今日完成"><textarea value={draft.todayCompleted} onChange={(event) => update("todayCompleted", event.target.value)} rows={4} maxLength={8000} disabled={disabled} /></Field>
      <Field label="数据与事实"><textarea value={draft.facts} onChange={(event) => update("facts", event.target.value)} rows={4} maxLength={8000} disabled={disabled} /></Field>
      <Field label="有效动作"><textarea value={draft.effectiveActions} onChange={(event) => update("effectiveActions", event.target.value)} rows={4} maxLength={8000} disabled={disabled} /></Field>
      <Field label="问题"><textarea value={draft.problems} onChange={(event) => update("problems", event.target.value)} rows={4} maxLength={8000} disabled={disabled} /></Field>
      <Field label="今日判断"><textarea value={draft.judgment} onChange={(event) => update("judgment", event.target.value)} rows={4} maxLength={8000} disabled={disabled} /></Field>
      <Field label="明日最重要动作"><textarea value={draft.tomorrowAction} onChange={(event) => update("tomorrowAction", event.target.value)} rows={3} maxLength={4000} disabled={disabled} /></Field>
    </>
  );
}

function compositionGuard(ref: React.MutableRefObject<boolean>) {
  return {
    onCompositionStartCapture: () => { ref.current = true; },
    onCompositionEndCapture: () => { ref.current = false; },
    onKeyDownCapture: (event: React.KeyboardEvent<HTMLFormElement>) => {
      if (event.key === "Enter" && (ref.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
    },
  };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="form-field"><span>{label}</span>{children}</label>;
}
