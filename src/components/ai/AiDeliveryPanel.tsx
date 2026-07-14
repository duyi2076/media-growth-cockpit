import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle, Plus, X } from "phosphor-react";
import {
  AiCollaborationApiError,
  createAiDelivery,
  type AiDelivery,
  type AiDeliveryKind,
  type AiRun,
  type CreateAiDeliveryInput,
  type CreateAiDeliveryResult,
} from "@/data/aiCollaborationClient";
import { openInObsidian } from "@/data/openObsidianClient";

const DELIVERY_OPTIONS: Array<{ value: AiDeliveryKind; label: string }> = [
  { value: "content_draft", label: "内容草稿" },
  { value: "review_draft", label: "复盘草稿" },
  { value: "next_day_task", label: "次日任务" },
];

function availableDeliveryOptions(run: AiRun): typeof DELIVERY_OPTIONS {
  const sourceType = run.sourceTask?.linkType;
  return DELIVERY_OPTIONS.filter((option) => {
    if (option.value === "content_draft") return ["topic", "content"].includes(sourceType ?? "");
    if (option.value === "review_draft") {
      return ["topic", "content", "content-review", "account-breakdown"].includes(sourceType ?? "");
    }
    return ["content-review", "account-breakdown", "daily-review"].includes(sourceType ?? "");
  });
}

function initialKind(run: AiRun): AiDeliveryKind {
  const preferred = ["review-content", "analyze-account"].includes(run.templateId)
    ? "review_draft"
    : ["review-day", "plan-tomorrow"].includes(run.templateId)
      ? "next_day_task"
      : "content_draft";
  return availableDeliveryOptions(run).some((option) => option.value === preferred)
    ? preferred
    : availableDeliveryOptions(run)[0]?.value ?? "content_draft";
}

function initialTitle(run: AiRun): string {
  const base = run.context?.title ?? run.sourceTask?.title ?? "未命名";
  const suffix = "｜草稿";
  return `${base.slice(0, 160 - suffix.length)}${suffix}`;
}

function initialSummary(run: AiRun): string {
  const text = run.finalText.trim().replace(/\s+/g, " ");
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

function targetLabel(
  kind: AiDeliveryKind,
  contentFormat: "文章" | "短视频口播",
  reviewKind: "content-review" | "account-breakdown",
): string {
  if (kind === "content_draft") return contentFormat === "文章" ? "内容资产 · 文章草稿" : "内容资产 · 短视频草稿";
  if (kind === "review_draft") return reviewKind === "content-review" ? "复盘与对标 · 内容复盘（待确认）" : "复盘与对标 · 账号拆解（待确认）";
  return "明日三件事";
}

function apiMessage(error: unknown): string {
  return error instanceof AiCollaborationApiError ? error.message : "成果写入失败，请稍后重试";
}

function receiptTypeLabel(delivery: AiDelivery): string {
  return {
    content: "内容草稿",
    review: "复盘草稿",
    task: "次日任务",
  }[delivery.targetType];
}

export function AiDeliveryPanel({
  run,
  onDelivered,
}: {
  run: AiRun;
  onDelivered: (result: CreateAiDeliveryResult) => void;
}) {
  const existing = run.deliveries[run.deliveries.length - 1] ?? null;
  const [kind, setKind] = useState<AiDeliveryKind>(() => initialKind(run));
  const [contentFormat, setContentFormat] = useState<"文章" | "短视频口播">(
    run.templateId === "draft-video" ? "短视频口播" : "文章",
  );
  const [reviewKind, setReviewKind] = useState<"content-review" | "account-breakdown">(
    run.context?.type === "account-breakdown" ? "account-breakdown" : "content-review",
  );
  const [title, setTitle] = useState(() => initialTitle(run));
  const [summary, setSummary] = useState(() => initialSummary(run));
  const [nextAction, setNextAction] = useState("");
  const [tasks, setTasks] = useState([""]);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const composing = useRef(false);
  const deliveryOptions = useMemo(() => availableDeliveryOptions(run), [run]);
  const lockedReviewKind = run.sourceTask?.linkType === "account-breakdown" ? "account-breakdown" : "content-review";

  useEffect(() => {
    setKind(initialKind(run));
    setContentFormat(run.templateId === "draft-video" ? "短视频口播" : "文章");
    setReviewKind(run.sourceTask?.linkType === "account-breakdown" ? "account-breakdown" : "content-review");
    setTitle(initialTitle(run));
    setSummary(initialSummary(run));
    setNextAction("");
    setTasks([""]);
    setPreviewing(false);
    setSubmitting(false);
    setError(null);
  }, [run.id, run.sourceTask?.linkType]);

  useEffect(() => {
    setReviewKind(lockedReviewKind);
    if (!deliveryOptions.some((option) => option.value === kind)) {
      setKind(deliveryOptions[0]?.value ?? "content_draft");
    }
  }, [deliveryOptions, kind, lockedReviewKind]);

  const normalizedTasks = useMemo(() => tasks.map((item) => item.trim()).filter(Boolean), [tasks]);
  const canPreview = kind === "content_draft"
    ? Boolean(title.trim() && run.finalText.trim())
    : kind === "review_draft"
      ? Boolean(title.trim() && run.finalText.trim())
      : normalizedTasks.length >= 1 && normalizedTasks.length <= 3;

  if (!run.sourceTask) return null;

  if (existing) {
    return <DeliveryReceipt delivery={existing} />;
  }

  if (deliveryOptions.length === 0) {
    return <div className="inline-error" role="alert">当前来源类型不支持业务成果交付。</div>;
  }

  const request = (): CreateAiDeliveryInput => {
    if (kind === "content_draft") {
      return { kind, contentFormat, title: title.trim() };
    }
    if (kind === "review_draft") {
      return {
        kind,
        reviewKind,
        title: title.trim(),
        ...(summary.trim() ? { summary: summary.trim() } : {}),
        nextAction: nextAction.trim(),
      };
    }
    return { kind, tasks: normalizedTasks };
  };

  const confirmDelivery = async () => {
    if (!canPreview || submitting || composing.current) return;
    setSubmitting(true);
    setError(null);
    try {
      onDelivered(await createAiDelivery(run.id, request()));
    } catch (deliveryError) {
      setError(apiMessage(deliveryError));
    } finally {
      setSubmitting(false);
    }
  };

  if (previewing) {
    return (
      <section className="ai-delivery-panel ai-delivery-preview" aria-labelledby="ai-delivery-heading">
        <div className="ai-delivery-heading">
          <div>
            <h3 id="ai-delivery-heading">成果预览</h3>
            <span>确认前不会修改 Obsidian</span>
          </div>
          <button type="button" className="quiet-button" onClick={() => setPreviewing(false)} disabled={submitting}>返回修改</button>
        </div>
        <dl className="ai-delivery-meta">
          <div><dt>成果类型</dt><dd>{DELIVERY_OPTIONS.find((item) => item.value === kind)?.label}</dd></div>
          <div><dt>目标位置</dt><dd>{targetLabel(kind, contentFormat, reviewKind)}</dd></div>
          <div><dt>来源任务</dt><dd>{run.sourceTask.date} · {run.sourceTask.title}</dd></div>
          <div><dt>来源资产</dt><dd>{run.context?.title ?? run.sourceTask.linkId}</dd></div>
          {kind !== "next_day_task" ? <div><dt>标题</dt><dd>{title.trim()}</dd></div> : null}
        </dl>
        {kind === "review_draft" ? (
          <div className="ai-delivery-review-preview">
            {summary.trim() ? <strong>{summary.trim()}</strong> : null}
            {nextAction.trim() ? <p>下一步：{nextAction.trim()}</p> : null}
          </div>
        ) : null}
        {kind === "next_day_task" ? (
          <ol className="ai-delivery-task-preview">
            {normalizedTasks.map((item) => <li key={item}>{item}</li>)}
          </ol>
        ) : (
          <div className="ai-delivery-body-preview">
            <span>正文</span>
            <div>{run.finalText}</div>
          </div>
        )}
        {error ? <div className="inline-error" role="alert">{error}</div> : null}
        <div className="ai-delivery-actions">
          <button type="button" className="quiet-button" onClick={() => setPreviewing(false)} disabled={submitting}>取消</button>
          <button type="button" className="primary-button" onClick={() => void confirmDelivery()} disabled={submitting}>
            <CheckCircle size={16} />{submitting ? "正在写入…" : "确认写入"}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="ai-delivery-panel" aria-labelledby="ai-delivery-heading">
      <div className="ai-delivery-heading">
        <div>
          <h3 id="ai-delivery-heading">成果交付</h3>
          <span>把本次结果送入下一业务环节</span>
        </div>
      </div>
      <form
        className="ai-delivery-form"
        onSubmit={(event) => event.preventDefault()}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
      >
        <fieldset className="ai-delivery-kind-picker">
          <legend>成果类型</legend>
          {deliveryOptions.map((option) => (
            <label key={option.value} className={kind === option.value ? "is-selected" : ""}>
              <input type="radio" name="delivery-kind" checked={kind === option.value} onChange={() => setKind(option.value)} />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>

        {kind === "content_draft" ? (
          <div className="ai-delivery-fields">
            <label className="form-field">
              <span>内容形式</span>
              <select value={contentFormat} onChange={(event) => setContentFormat(event.target.value as "文章" | "短视频口播")}>
                <option value="文章">文章</option>
                <option value="短视频口播">短视频</option>
              </select>
            </label>
            <label className="form-field ai-delivery-wide-field">
              <span>标题</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} />
            </label>
          </div>
        ) : null}

        {kind === "review_draft" ? (
          <div className="ai-delivery-fields">
            <label className="form-field">
              <span>复盘类型</span>
              <input value={reviewKind === "content-review" ? "内容复盘" : "账号拆解"} readOnly />
            </label>
            <label className="form-field ai-delivery-wide-field">
              <span>标题</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} />
            </label>
            <label className="form-field ai-delivery-full-field">
              <span>摘要（可选）</span>
              <textarea rows={2} value={summary} onChange={(event) => setSummary(event.target.value)} maxLength={4000} />
            </label>
            <label className="form-field ai-delivery-full-field">
              <span>下一步动作（可选）</span>
              <input value={nextAction} onChange={(event) => setNextAction(event.target.value)} maxLength={4000} />
            </label>
          </div>
        ) : null}

        {kind === "next_day_task" ? (
          <div className="ai-delivery-list-editor">
            <span>明日任务（1—3 条）</span>
            {tasks.map((task, index) => (
              <div key={index}>
                <input
                  value={task}
                  onChange={(event) => setTasks((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))}
                  maxLength={200}
                  aria-label={`明日任务 ${index + 1}`}
                />
                {tasks.length > 1 ? (
                  <button type="button" onClick={() => setTasks((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`删除明日任务 ${index + 1}`}>
                    <X size={14} />
                  </button>
                ) : null}
              </div>
            ))}
            {tasks.length < 3 ? <button type="button" className="ai-delivery-add-row" onClick={() => setTasks((current) => [...current, ""])}><Plus size={14} />添加任务</button> : null}
          </div>
        ) : null}

        {error ? <div className="inline-error" role="alert">{error}</div> : null}
        <div className="ai-delivery-actions">
          <button type="button" className="primary-button" disabled={!canPreview} onClick={() => {
            if (composing.current) return;
            setError(null);
            setPreviewing(true);
          }}>预览成果</button>
        </div>
      </form>
    </section>
  );
}

function DeliveryReceipt({ delivery }: { delivery: AiDelivery }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openDelivery = async () => {
    if (opening) return;
    setOpening(true);
    setError(null);
    try {
      await openInObsidian(delivery.targetRelativePath);
    } catch {
      setError("暂时无法打开成果，请在 Obsidian 中查看");
    } finally {
      setOpening(false);
    }
  };

  return (
    <section className="ai-delivery-panel ai-delivery-receipt" aria-labelledby="ai-delivery-receipt-heading">
      <div className="ai-delivery-heading">
        <div>
          <h3 id="ai-delivery-receipt-heading">
            <CheckCircle size={17} weight="fill" />
            {delivery.targetType === "content"
              ? "草稿已写入 · 待审核"
              : delivery.targetType === "review"
                ? "复盘已写入 · 待人工确认"
                : "明日任务已添加"}
          </h3>
          <span>{new Date(delivery.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
        </div>
      </div>
      <dl className="ai-delivery-meta">
        <div><dt>成果</dt><dd>{delivery.targetTitle}</dd></div>
        <div><dt>类型</dt><dd>{receiptTypeLabel(delivery)}</dd></div>
      </dl>
      <p className="ai-delivery-receipt-note">原任务仍未完成。</p>
      {error ? <div className="inline-error" role="alert">{error}</div> : null}
      <div className="ai-delivery-actions">
        <button type="button" className="quiet-button" onClick={() => void openDelivery()} disabled={opening}>
          {opening ? "正在打开…" : "在 Obsidian 中打开"}
        </button>
      </div>
    </section>
  );
}
