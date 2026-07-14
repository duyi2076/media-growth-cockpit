import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, PencilSimple, Plus } from "phosphor-react";
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
import { newClientRequestId } from "@/data/clientRequestId";
import {
  ReviewAssetsApiError,
  ReviewAssetsConflictError,
  createReviewAsset,
  getReviewAssets,
  updateReviewAsset,
  type CreateReviewAssetInput,
  type ReviewAssetConfirmation,
  type ReviewAssetKind,
  type ReviewAssetSnapshot,
  type UpdateReviewAssetPatch,
} from "@/data/reviewAssetsClient";
import { useVaultSync } from "@/hooks/useVaultSync";
import { LoadingState, ErrorState } from "./GrowthPage";
import type { ContentItem } from "@/types";

type ReviewTab = "content" | "account";

const confirmationOptions = [
  { value: "待人工确认", label: "待人工确认" },
  { value: "已确认", label: "已确认" },
];

function kindForTab(tab: ReviewTab): ReviewAssetKind {
  return tab === "content" ? "content-review" : "account-breakdown";
}

function apiMessage(error: unknown): string {
  return error instanceof ReviewAssetsApiError ? error.message : "复盘内容暂时无法保存，请稍后重试";
}

function reviewLabel(kind: ReviewAssetKind): string {
  return kind === "content-review" ? "内容复盘" : "账号拆解";
}

export function ReviewsPage() {
  const { data, loading, error, refresh } = useWorkbenchIndex();
  const [snapshots, setSnapshots] = useState<ReviewAssetSnapshot[]>([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<ReviewTab>("content");
  const [search, setSearch] = useState("");
  const [confirmationFilter, setConfirmationFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [conflictReloadToken, setConflictReloadToken] = useState(0);
  const createRequestRef = useRef<string | null>(null);

  const loadSnapshots = useCallback(async () => {
    try {
      const result = await getReviewAssets();
      setSnapshots(result.items);
      setLoadError(null);
    } catch (caught) {
      setLoadError(apiMessage(caught));
    } finally {
      setSnapshotsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSnapshots();
  }, [loadSnapshots]);

  useVaultSync(["review-assets"], loadSnapshots);

  const visibleItems = useMemo(() => {
    const kind = kindForTab(activeTab);
    const query = search.trim().toLowerCase();
    return snapshots
      .filter((item) => item.kind === kind)
      .filter((item) => !confirmationFilter || item.confirmation === confirmationFilter)
      .filter((item) => {
        if (!query) return true;
        return item.title.toLowerCase().includes(query)
          || item.summary.toLowerCase().includes(query)
          || item.findings.toLowerCase().includes(query)
          || (item.platform?.toLowerCase().includes(query) ?? false);
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [activeTab, confirmationFilter, search, snapshots]);

  const selected = snapshots.find((item) => item.id === selectedId) ?? null;

  const saveCreated = async (draft: CreateReviewAssetInput) => {
    setSaving(true);
    setSyncError(null);
    try {
      createRequestRef.current ??= newClientRequestId();
      const created = await createReviewAsset(draft, createRequestRef.current);
      createRequestRef.current = null;
      setSnapshots((items) => [created, ...items.filter((item) => item.id !== created.id)]);
      setShowAdd(false);
      setSelectedId(created.id);
      try {
        await refresh();
      } catch {
        setSyncError("已保存，摘要暂未刷新");
      }
      return true;
    } catch (caught) {
      if (caught instanceof ReviewAssetsConflictError) {
        createRequestRef.current = null;
        setSnapshots((items) => [caught.snapshot, ...items.filter((item) => item.id !== caught.snapshot.id)]);
        setShowAdd(false);
        setSelectedId(caught.snapshot.id);
        setConflictReloadToken((value) => value + 1);
        setSyncError("已找回首次保存的复盘；重试前修改的内容未保存，请核对后继续编辑");
      } else {
        setSyncError(apiMessage(caught));
      }
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveUpdated = async (
    id: string,
    patch: UpdateReviewAssetPatch,
    expectedHash: string,
  ): Promise<ReviewAssetSnapshot | null> => {
    setSaving(true);
    setSyncError(null);
    try {
      const saved = await updateReviewAsset(id, patch, expectedHash);
      setSnapshots((items) => items.map((candidate) => candidate.id === saved.id ? saved : candidate));
      try {
        await refresh();
      } catch {
        setSyncError("已保存，摘要暂未刷新");
      }
      return saved;
    } catch (caught) {
      if (caught instanceof ReviewAssetsConflictError) {
        setSnapshots((items) => items.map((candidate) => candidate.id === caught.snapshot.id ? caught.snapshot : candidate));
        setConflictReloadToken((value) => value + 1);
        setSyncError("已载入最新版本，请重新编辑后保存");
      } else {
        setSyncError(apiMessage(caught));
      }
      return null;
    } finally {
      setSaving(false);
    }
  };

  if (loading || snapshotsLoading) return <LoadingState />;
  if (error && !data) return <ErrorState message={error} />;

  const closeDetail = () => {
    setSelectedId(null);
    setShowAdd(false);
    createRequestRef.current = null;
  };

  const detail = selected ? (
    <DetailDrawer key={`review:${selected.id}`} title={`编辑${reviewLabel(selected.kind)}`} onClose={closeDetail}>
      <EditReviewForm
        item={selected}
        contents={data?.contents ?? []}
        disabled={saving}
        conflictReloadToken={conflictReloadToken}
        onSave={(patch, expectedHash) => saveUpdated(selected.id, patch, expectedHash)}
      />
    </DetailDrawer>
  ) : showAdd ? (
    <DetailDrawer
      key={`add:${activeTab}`}
      title={activeTab === "content" ? "新建内容复盘" : "新建账号拆解"}
      onClose={closeDetail}
    >
      <AddReviewForm
        kind={kindForTab(activeTab)}
        contents={data?.contents ?? []}
        disabled={saving}
        onSubmit={saveCreated}
      />
    </DetailDrawer>
  ) : null;

  const switchTab = (tab: ReviewTab) => {
    setActiveTab(tab);
    setSearch("");
    setConfirmationFilter("");
    closeDetail();
  };

  const hasFilters = Boolean(search || confirmationFilter);

  return (
    <div>
      <ModuleHeader title="复盘与对标" goal="把每次结果沉淀成下一次能执行的判断。">
        <div role="tablist" aria-label="复盘与对标视图" className="review-tabs">
          <TabButton active={activeTab === "content"} onClick={() => switchTab("content")}>内容复盘</TabButton>
          <TabButton active={activeTab === "account"} onClick={() => switchTab("account")}>账号拆解</TabButton>
        </div>
      </ModuleHeader>

      <div className="workbench-toolbar review-toolbar">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={activeTab === "content" ? "搜索复盘标题或结论…" : "搜索账号、平台或结论…"}
          label={activeTab === "content" ? "搜索内容复盘" : "搜索账号拆解"}
        />
        <FilterSelect
          value={confirmationFilter}
          onChange={setConfirmationFilter}
          options={confirmationOptions}
          placeholder="全部确认状态"
          label="确认状态"
        />
        {hasFilters ? (
          <button type="button" className="quiet-button" onClick={() => { setSearch(""); setConfirmationFilter(""); }}>
            清除筛选
          </button>
        ) : null}
        <div className="toolbar-actions">
          <button
            type="button"
            className="primary-button"
            onClick={() => {
              setSelectedId(null);
              createRequestRef.current = newClientRequestId();
              setShowAdd(true);
            }}
          >
            <Plus size={16} weight="bold" />
            {activeTab === "content" ? "新建内容复盘" : "新建账号拆解"}
          </button>
        </div>
      </div>

      <WorkbenchGrid detail={detail} onCloseDetail={closeDetail}>
        {syncError || loadError ? <div className="inline-error" role="alert">{syncError ?? loadError}</div> : null}
        {visibleItems.length === 0 ? (
          <EmptyState
            title={hasFilters ? "没有匹配的复盘资产" : activeTab === "content" ? "还没有内容复盘" : "还没有账号拆解"}
            description={hasFilters ? "换个筛选条件试试。" : activeTab === "content" ? "复盘一次已发布内容，把结论留给下一次创作。" : "从一个真实账号或代表作品链接开始拆解。"}
          />
        ) : (
          <div className="review-card-grid">
            {visibleItems.map((item) => (
              <ReviewAssetCard
                key={item.id}
                item={item}
                selected={selectedId === item.id}
                onClick={() => { setShowAdd(false); setSelectedId(item.id); }}
                confirming={saving}
                onConfirm={() => saveUpdated(item.id, { confirmation: "已确认" }, item.hash)}
              />
            ))}
          </div>
        )}
      </WorkbenchGrid>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onClick} className={active ? "is-active" : ""}>
      {children}
    </button>
  );
}

function ReviewAssetCard({ item, selected, onClick, confirming, onConfirm }: {
  item: ReviewAssetSnapshot;
  selected: boolean;
  onClick: () => void;
  confirming: boolean;
  onConfirm: () => Promise<ReviewAssetSnapshot | null>;
}) {
  return (
    <Card
      onClick={onClick}
      selected={selected}
      ariaLabel={`编辑${reviewLabel(item.kind)}：${item.title}`}
      style={{ padding: "12px 14px" }}
    >
      <div className="review-card-content">
        <div className="review-card-meta">
          <StatusBadge status={item.confirmation} />
          <div className="review-card-meta-actions">
            <span>{item.platform || reviewLabel(item.kind)}</span>
            {item.confirmation === "待人工确认" ? (
              <button
                type="button"
                className="review-card-confirm"
                disabled={confirming}
                onClick={(event) => {
                  event.stopPropagation();
                  void onConfirm();
                }}
                onKeyDown={(event) => event.stopPropagation()}
                aria-label={`确认${reviewLabel(item.kind)}：${item.title}`}
              >
                <Check size={13} aria-hidden="true" />确认
              </button>
            ) : null}
            <span className="review-card-edit-hint"><PencilSimple size={13} aria-hidden="true" />编辑</span>
          </div>
        </div>
        <h2>{item.title}</h2>
        <p>{item.summary || item.findings || "尚未填写复盘结论"}</p>
        <div className="review-card-next">下一步：{item.nextAction || "待补充"}</div>
        <time dateTime={item.updatedAt}>{item.updatedAt.slice(0, 10)}</time>
      </div>
    </Card>
  );
}

interface ReviewDraft {
  title: string;
  sourceUrl: string;
  platform: string;
  relatedContentId: string;
  summary: string;
  findings: string;
  nextAction: string;
}

function emptyDraft(): ReviewDraft {
  return {
    title: "",
    sourceUrl: "",
    platform: "",
    relatedContentId: "",
    summary: "",
    findings: "",
    nextAction: "",
  };
}

function draftFrom(item: ReviewAssetSnapshot): ReviewDraft {
  return {
    title: item.title,
    sourceUrl: item.sourceUrl ?? "",
    platform: item.platform ?? "",
    relatedContentId: item.relatedContentId ?? "",
    summary: item.summary,
    findings: item.findings,
    nextAction: item.nextAction,
  };
}

function normalizeDraft(kind: ReviewAssetKind, draft: ReviewDraft): CreateReviewAssetInput {
  return {
    kind,
    title: draft.title.trim(),
    sourceUrl: draft.sourceUrl.trim() || null,
    platform: draft.platform.trim() || null,
    relatedContentId: kind === "content-review" ? draft.relatedContentId || null : null,
    summary: draft.summary.trim(),
    findings: draft.findings.trim(),
    nextAction: draft.nextAction.trim(),
  };
}

function validateDraft(kind: ReviewAssetKind, draft: CreateReviewAssetInput): string | null {
  if (!draft.title) return "请填写标题";
  if ([draft.summary, draft.findings, draft.nextAction].some((value) => /^ {0,3}##[ \t]+/m.test(value))) {
    return "摘要、核心发现和下一步不能使用「## 标题」，请改用普通文字或项目符号";
  }
  if (draft.sourceUrl) {
    try {
      if (new URL(draft.sourceUrl).protocol !== "https:") return "来源链接必须使用 https://";
    } catch {
      return "请输入有效的 https:// 链接";
    }
  }
  if (kind === "content-review" && !draft.relatedContentId && !draft.sourceUrl) {
    return "请选择关联内容，或填写已发布内容的 https:// 链接";
  }
  if (kind === "account-breakdown" && !draft.sourceUrl) {
    return "账号拆解必须填写账号或代表作品的 https:// 链接";
  }
  return null;
}

function AddReviewForm({ kind, contents, disabled, onSubmit }: {
  kind: ReviewAssetKind;
  contents: ContentItem[];
  disabled: boolean;
  onSubmit: (draft: CreateReviewAssetInput) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<ReviewDraft>(emptyDraft);
  const [validation, setValidation] = useState<string | null>(null);
  const composingRef = useRef(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (composingRef.current) return;
    const normalized = normalizeDraft(kind, draft);
    const issue = validateDraft(kind, normalized);
    setValidation(issue);
    if (issue) return;
    await onSubmit(normalized);
  };

  return (
    <form className="content-editor-form" onSubmit={submit} {...compositionGuard(composingRef)}>
      <ReviewFields kind={kind} draft={draft} setDraft={setDraft} contents={contents} disabled={disabled} />
      {validation ? <div className="form-validation" role="alert">{validation}</div> : null}
      <button type="submit" className="primary-button full-width" disabled={disabled || !draft.title.trim()}>
        {disabled ? "保存中…" : kind === "content-review" ? "保存内容复盘" : "保存账号拆解"}
      </button>
    </form>
  );
}

function EditReviewForm({ item, contents, disabled, conflictReloadToken, onSave }: {
  item: ReviewAssetSnapshot;
  contents: ContentItem[];
  disabled: boolean;
  conflictReloadToken: number;
  onSave: (patch: UpdateReviewAssetPatch, expectedHash: string) => Promise<ReviewAssetSnapshot | null>;
}) {
  const [draft, setDraft] = useState<ReviewDraft>(() => draftFrom(item));
  const [baseHash, setBaseHash] = useState(item.hash);
  const [dirty, setDirty] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const composingRef = useRef(false);

  useEffect(() => {
    setDraft(draftFrom(item));
    setBaseHash(item.hash);
    setDirty(false);
    setValidation(null);
    setSaved(false);
  }, [item.id, conflictReloadToken]);

  useEffect(() => {
    if (item.hash === baseHash || dirty) return;
    setDraft(draftFrom(item));
    setBaseHash(item.hash);
    setValidation(null);
    setSaved(false);
  }, [baseHash, dirty, item]);

  const persist = async (confirmation?: ReviewAssetConfirmation) => {
    const normalized = normalizeDraft(item.kind, draft);
    const issue = validateDraft(item.kind, normalized);
    setValidation(issue);
    if (issue) return;
    if (confirmation === "已确认" && (!normalized.findings || !normalized.nextAction)) {
      setValidation("确认前请填写核心发现和下一步动作");
      return;
    }

    const patch: UpdateReviewAssetPatch = {};
    if (normalized.title !== item.title) patch.title = normalized.title;
    if (normalized.sourceUrl !== item.sourceUrl) patch.sourceUrl = normalized.sourceUrl;
    if (normalized.platform !== item.platform) patch.platform = normalized.platform;
    if (normalized.relatedContentId !== item.relatedContentId) patch.relatedContentId = normalized.relatedContentId;
    if (normalized.summary !== item.summary) patch.summary = normalized.summary;
    if (normalized.findings !== item.findings) patch.findings = normalized.findings;
    if (normalized.nextAction !== item.nextAction) patch.nextAction = normalized.nextAction;
    if (confirmation && confirmation !== item.confirmation) patch.confirmation = confirmation;
    if (Object.keys(patch).length === 0) {
      setBaseHash(item.hash);
      setDirty(false);
      setSaved(true);
      return;
    }
    const savedSnapshot = await onSave(patch, baseHash);
    if (!savedSnapshot) {
      setSaved(false);
      return;
    }
    setDraft(draftFrom(savedSnapshot));
    setBaseHash(savedSnapshot.hash);
    setDirty(false);
    setSaved(true);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (composingRef.current) return;
    await persist();
  };

  return (
    <form className="content-editor-form" onSubmit={submit} {...compositionGuard(composingRef)}>
      <div className="drawer-status-row">
        <StatusBadge status={item.confirmation} />
        <span>{reviewLabel(item.kind)} · 更新于 {item.updatedAt.slice(0, 10)}</span>
      </div>
      <ReviewFields
        kind={item.kind}
        draft={draft}
        setDraft={(next) => {
          setDraft(next);
          setDirty(true);
          setSaved(false);
        }}
        contents={contents}
        disabled={disabled}
      />
      {validation ? <div className="form-validation" role="alert">{validation}</div> : null}
      <button type="submit" className="primary-button full-width" disabled={disabled}>
        {disabled ? "保存中…" : saved ? <><Check size={16} />已保存</> : "保存修改"}
      </button>
      {item.confirmation === "待人工确认" ? (
        <button type="button" className="quiet-button full-width" disabled={disabled} onClick={() => void persist("已确认")}>
          确认并保存
        </button>
      ) : null}
      <OpenInObsidianButton source={`review:${item.id}`} />
    </form>
  );
}

function ReviewFields({ kind, draft, setDraft, contents, disabled }: {
  kind: ReviewAssetKind;
  draft: ReviewDraft;
  setDraft: (draft: ReviewDraft) => void;
  contents: ContentItem[];
  disabled: boolean;
}) {
  const update = <K extends keyof ReviewDraft>(key: K, value: ReviewDraft[K]) => setDraft({ ...draft, [key]: value });
  return (
    <>
      <Field label="标题">
        <input value={draft.title} onChange={(event) => update("title", event.target.value)} maxLength={160} required disabled={disabled} />
      </Field>
      {kind === "content-review" ? (
        <Field label="关联内容（与发布链接至少填一项）">
          <select value={draft.relatedContentId} onChange={(event) => update("relatedContentId", event.target.value)} disabled={disabled}>
            <option value="">不关联内容资产</option>
            {contents.map((content) => <option key={content.id} value={content.id}>{content.title}</option>)}
          </select>
        </Field>
      ) : null}
      <Field label={kind === "content-review" ? "已发布内容链接" : "账号或代表作品链接（必填）"}>
        <input
          type="url"
          inputMode="url"
          placeholder="https://"
          value={draft.sourceUrl}
          onChange={(event) => update("sourceUrl", event.target.value)}
          required={kind === "account-breakdown"}
          disabled={disabled}
        />
      </Field>
      <Field label="平台（可选）">
        <input value={draft.platform} onChange={(event) => update("platform", event.target.value)} maxLength={40} disabled={disabled} />
      </Field>
      <Field label="背景摘要">
        <textarea value={draft.summary} onChange={(event) => update("summary", event.target.value)} rows={3} maxLength={4000} disabled={disabled} />
      </Field>
      <Field label={kind === "content-review" ? "复盘结论" : "拆解发现"}>
        <textarea value={draft.findings} onChange={(event) => update("findings", event.target.value)} rows={6} maxLength={12000} disabled={disabled} />
      </Field>
      <Field label="下一步动作">
        <textarea value={draft.nextAction} onChange={(event) => update("nextAction", event.target.value)} rows={3} maxLength={4000} disabled={disabled} />
      </Field>
    </>
  );
}

function compositionGuard(ref: React.MutableRefObject<boolean>) {
  return {
    onCompositionStartCapture: () => { ref.current = true; },
    onCompositionEndCapture: () => { ref.current = false; },
    onKeyDownCapture: (event: React.KeyboardEvent<HTMLFormElement>) => {
      if (event.key === "Enter" && (ref.current || event.nativeEvent.isComposing || event.keyCode === 229)) {
        event.preventDefault();
      }
    },
  };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="form-field"><span>{label}</span>{children}</label>;
}
