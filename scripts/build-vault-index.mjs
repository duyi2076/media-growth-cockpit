#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  FrontmatterError,
  parseFrontmatter,
  extractBody,
} from "./lib/frontmatter.mjs";
import {
  hasSecret,
  isFullIsoTimestamp,
  isSafeRelativePath,
  readSafeMarkdown,
  resolveUnderRoot,
  sanitizeUrl,
  sha256,
  toPlainText,
  MAX_FILE_BYTES,
  SecurityError,
} from "./lib/security.mjs";
import {
  extractFirstHeading,
  normalizePlatformDisplay,
  parseMarkdownTable,
  parseNumberListSection,
} from "./lib/parse.mjs";
import { validateIndexCandidate } from "./validate-data.mjs";
import {
  COCKPIT_SETTINGS_RELATIVE_PATH,
  readCockpitSettingsSync,
} from "../server/cockpit-settings-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ALLOWED_ROOT = process.env.V2_VAULT_ROOT || process.env.OBSIDIAN_VAULT_ROOT || path.join(os.homedir(), "第二大脑-v2");
const RUN_DIR = path.resolve(process.env.COCKPIT_STATE_ROOT ?? path.join(os.homedir(), ".media-growth-cockpit"));
const PUBLIC_DATA_DIR = path.resolve(__dirname, "../public/data");
const CANONICAL_INDEX = path.join(RUN_DIR, "index.json");
const PUBLIC_INDEX = path.join(PUBLIC_DATA_DIR, "index.json");
const BUILD_REPORT = path.join(RUN_DIR, "build-report.json");
const LOG_DIR = path.join(RUN_DIR, "logs");

const CONTENT_STATUSES = [
  "候选选题",
  "已立项",
  "待发布",
  "已发布",
  "待复盘",
  "已归档",
];
const CONTENT_CHANNELS = ["公众号", "小红书", "抖音", "视频号", "B 站", "X"];
const TASK_STATUSES = ["待办", "进行中", "阻塞", "待验收", "已完成"];
const TASK_TYPES = ["人工任务", "Agent 任务", "人机协作任务"];
const PRIORITIES = ["P0", "P1", "P2", "P3"];
const ASSET_TYPES = ["判断", "方法", "复盘", "故事", "概念", "原始材料", "内容资产"];
const CONFIRMATION_STATUSES = ["待人工确认", "已确认"];
const SENSITIVITY_LEVELS = ["公开", "内部", "敏感"];
const REVIEW_KINDS = ["content-review", "account-breakdown"];
const REVIEW_TOPIC_BY_KIND = {
  "content-review": "内容复盘",
  "account-breakdown": "账号拆解",
};
const SAFE_RELATED_CONTENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const DAILY_TASK_LINK_TYPES = new Set([
  "topic",
  "content",
  "content-review",
  "account-breakdown",
  "daily-review",
  "task",
]);
const EXPERIMENT_RESULTS = ["有效", "无效", "证据不足"];
const ACTION_TARGET_IDS = [
  "article-output",
  "video-output",
  "platform-publish",
  "content-review",
  "account-breakdown",
];
const ACTION_COUNT_RULES = [
  "completed_article_assets",
  "completed_video_assets",
  "platform_publication_records",
  "confirmed_daily_reviews",
  "confirmed_account_breakdowns",
];

const CORE_WHITELIST = [
  "40-业务资产/01-定位与公司说明/平台账号注册表.md",
];

const CORE_DYNAMIC_SCAN_ROOTS = [
  "10-原始材料/",
  "20-知识资产/",
  "30-内容资产/",
  "60-数据与看板/04-实验记录/",
  "60-数据与看板/05-经营看板/每日复盘/",
  "00-收件箱/待确认文件/",
];

const EXCLUDED_DIR_NAMES = new Set([
  ".obsidian",
  "90-归档",
  "99-系统",
  "模板",
  "属性字典",
  "分类规则",
  "迁移台账",
  "索引与导航",
]);

class SchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = "SchemaError";
  }
}

function fail(message) {
  throw new Error(message);
}

function assertString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SchemaError(`${name} 必须是字符串`);
  }
  return value.trim();
}

function assertInteger(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = typeof value === "string" ? Number(value.replace(/,/g, "")) : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new SchemaError(`${name} 必须是 ${min}-${max} 的整数`);
  }
  return n;
}

function assertEnum(value, name, allowed) {
  if (!allowed.includes(value)) {
    throw new SchemaError(`${name} 必须是 ${allowed.join(" / ")} 之一，实际为 ${value}`);
  }
  return value;
}

function assertHttpsUrl(value, name) {
  const url = sanitizeUrl(value);
  if (!url) {
    throw new SchemaError(`${name} 必须是 https URL`);
  }
  return url;
}

function assertArray(value, name) {
  if (!Array.isArray(value)) {
    throw new SchemaError(`${name} 必须是数组`);
  }
  return value;
}

function mapContentFormat(value) {
  if (value === "短视频") return "短视频口播";
  if (["文章", "短视频口播", "图文卡片", "直播稿", "系列"].includes(value)) return value;
  throw new SchemaError(`未知内容形态: ${value}`);
}

function parseContentChannels(value) {
  const channels = assertArray(value, "channels").map((item, index) => {
    const normalized = normalizePlatformDisplay(assertString(item, `channels[${index}]`));
    return assertEnum(normalized, `channels[${index}]`, CONTENT_CHANNELS);
  });
  if (new Set(channels).size !== channels.length) throw new SchemaError("channels 不能重复");
  return channels;
}

function deriveEvidenceStatus(records) {
  if (!Array.isArray(records) || records.length === 0) return "待补充";
  if (records.some((record) => record.verified)) return "有证据";
  if (records.some((record) => record.hasObservation)) return "部分证据";
  return "待补充";
}

function parseOptionalTimestamp(value, name) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new SchemaError(`${name} 必须是有效时间`);
  }
  return value;
}

function isFullTimestamp(value) {
  return isFullIsoTimestamp(value);
}

export function parsePublicationRecords(records) {
  if (!Array.isArray(records)) return [];
  return records.map((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new SchemaError(`published_records[${index}] 必须是对象`);
    }
    const platform = assertString(record.platform, `published_records[${index}].platform`);
    const publishedAt = parseOptionalTimestamp(record.published_at, `published_records[${index}].published_at`);
    const url = record.url === undefined || record.url === null || record.url === ""
      ? null
      : assertHttpsUrl(record.url, `published_records[${index}].url`);
    const evidenceRef = typeof record.evidence_ref === "string" && record.evidence_ref.trim()
      ? record.evidence_ref.trim()
      : null;
    const verified = record.verification === "已核验"
      && isFullTimestamp(publishedAt)
      && Boolean(url || evidenceRef);
    const hasObservation = verified
      || Boolean(url || evidenceRef)
      || (typeof record.observed_plays === "number" && record.observed_plays >= 0)
      || record.observed === "已发布";
    return { platform, publishedAt, url, evidenceRef, verified, hasObservation };
  });
}

export function isPublicationInCampaign(record, campaignStartedAt) {
  if (!campaignStartedAt || !record?.verified || !record.publishedAt) return false;
  return Date.parse(record.publishedAt) >= Date.parse(campaignStartedAt);
}

export function contentCompletedAt(frontmatter, publicationRecords, rel = "内容资产") {
  const explicit = frontmatter?.completed_at;
  if (explicit !== undefined && explicit !== null && explicit !== "") {
    if (typeof explicit !== "string" || !isFullIsoTimestamp(explicit)) {
      throw new SchemaError(`${rel} 的 completed_at 必须是完整 ISO 时间`);
    }
    return explicit;
  }

  const verifiedPublicationTimes = (publicationRecords ?? [])
    .filter((record) => record?.verified && record.publishedAt)
    .map((record) => record.publishedAt)
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  return verifiedPublicationTimes[0] ?? null;
}

export function isCompletionInCampaign(event, campaignStartedAt) {
  if (!campaignStartedAt || !event?.completedAt) return false;
  return Date.parse(event.completedAt) >= Date.parse(campaignStartedAt);
}

export function dedupePublicationEvents(records) {
  const seen = new Set();
  return records.filter((record) => {
    const key = record.url
      ? `url:${record.url}`
      : `evidence:${record.evidenceRef}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value.replace(/,/g, ""));
  return NaN;
}

function readAllMarkdownFiles(rootReal, runtimeSettings) {
  const files = new Map();
  const warnings = [];
  const whitelist = [
    ...CORE_WHITELIST,
    runtimeSettings.baselineRelativePath,
    `${runtimeSettings.projectRelativeDir}/01-目标与验收.md`,
  ];
  const settingsPath = COCKPIT_SETTINGS_RELATIVE_PATH.split(path.sep).join("/");
  if (fs.existsSync(path.join(rootReal, settingsPath))) whitelist.push(settingsPath);

  for (const rel of whitelist) {
    if (!isSafeRelativePath(rel)) {
      throw new SecurityError(`白名单路径非法: ${rel}`);
    }
    files.set(rel, { required: true, dynamic: false });
  }

  for (const scanRoot of [...CORE_DYNAMIC_SCAN_ROOTS, `${runtimeSettings.projectRelativeDir}/`]) {
    const scanRel = scanRoot.replace(/\/$/, "");
    const scanAbs = path.join(rootReal, scanRel);
    walk(scanAbs, scanRel);
  }

  function walk(dirAbs, dirRel) {
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch (err) {
      if (err?.code === "ENOENT") return;
      warnings.push({ path: dirRel, reason: `无法读取目录: ${err.message}` });
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      const childRel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      const childAbs = path.join(dirAbs, entry.name);
      if (entry.isSymbolicLink()) {
        warnings.push({ path: childRel, reason: "拒绝扫描软链接目录" });
        continue;
      }
      if (entry.isDirectory()) {
        walk(childAbs, childRel);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        if (!files.has(childRel)) {
          files.set(childRel, { required: false, dynamic: true });
        }
      }
    }
  }

  return { files, warnings };
}

function computeManifest(rootReal, files) {
  const manifest = [];
  for (const [rel, meta] of files.entries()) {
    try {
      const { content } = readSafeMarkdown(rootReal, rel);
      manifest.push({ path: rel, sha256: sha256(content) });
    } catch (error) {
      if (meta.required) throw error;
      // 动态扫描文件的读取错误由主解析循环记入 warnings；manifest 只比较可读输入。
    }
  }
  manifest.sort((a, b) => a.path.localeCompare(b.path));
  return manifest;
}

function parseAccountRegistry(body) {
  const tables = parseMarkdownTable(body);
  const table = tables.find((t) => t.headers.includes("account_id"));
  if (!table) throw new SchemaError("平台账号注册表缺少账号列表表格");
  const idx = Object.fromEntries(table.headers.map((h, i) => [h, i]));
  const requiredHeaders = ["account_id", "platform", "display_name", "handle", "profile_url", "current_followers", "as_of", "source_evidence", "active"];
  for (const h of requiredHeaders) {
    if (!(h in idx)) throw new SchemaError(`平台账号注册表缺少列: ${h}`);
  }
  const accounts = table.rows.map((row) => ({
    id: row[idx.account_id],
    platform: normalizePlatformDisplay(row[idx.platform]),
    account: row[idx.account_id],
    displayName: row[idx.display_name],
    handle: row[idx.handle],
    profileUrl: assertHttpsUrl(row[idx.profile_url], "profile_url"),
    currentFollowers: assertInteger(row[idx.current_followers], "current_followers"),
    targetFollowers: null,
    gap: null,
    asOf: row[idx.as_of],
    sourceEvidence: row[idx.source_evidence],
    active: row[idx.active] === "true" || row[idx.active] === true,
  }));
  for (const account of accounts) {
    if (!CONTENT_CHANNELS.includes(account.platform)) {
      throw new SchemaError(`平台账号注册表包含当前版本不支持的平台: ${account.platform}`);
    }
  }
  if (new Set(accounts.map((account) => account.platform)).size !== accounts.length) {
    throw new SchemaError("平台账号注册表当前每个平台只能包含一个账号");
  }
  return accounts;
}

function parseBaselineAccounts(body) {
  const tables = parseMarkdownTable(body);
  const table = tables.find((t) => t.headers.includes("平台") && t.headers.includes("粉丝数"));
  if (!table) throw new SchemaError("粉丝基线缺少平台粉丝明细表格");
  const idx = Object.fromEntries(table.headers.map((h, i) => [h, i]));
  const values = new Map();
  for (const row of table.rows) {
    const platform = normalizePlatformDisplay(row[idx.平台]);
    const val = parseNumber(row[idx.粉丝数]);
    if (platform && !Number.isNaN(val)) values.set(platform, val);
  }
  return values;
}

function parseActionTargetDefinitions(value) {
  const rows = assertArray(value, "action_targets");
  if (rows.length !== ACTION_TARGET_IDS.length) {
    throw new SchemaError(`action_targets 必须包含 ${ACTION_TARGET_IDS.length} 项`);
  }
  const seenIds = new Set();
  const seenRules = new Set();
  const definitions = rows.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new SchemaError(`action_targets[${index}] 必须是对象`);
    }
    const id = assertEnum(row.id, `action_targets[${index}].id`, ACTION_TARGET_IDS);
    const rawCountRule = row.count_rule === "confirmed_content_reviews" && id === "content-review"
      ? "confirmed_daily_reviews"
      : row.count_rule;
    const countRule = assertEnum(
      rawCountRule,
      `action_targets[${index}].count_rule`,
      ACTION_COUNT_RULES,
    );
    if (seenIds.has(id)) throw new SchemaError(`action_targets id 重复: ${id}`);
    if (seenRules.has(countRule)) throw new SchemaError(`action_targets count_rule 重复: ${countRule}`);
    seenIds.add(id);
    seenRules.add(countRule);
    return {
      id,
      label: assertString(row.label, `action_targets[${index}].label`),
      target: row.target === null ? null : assertInteger(row.target, `action_targets[${index}].target`, { min: 1, max: 1_000_000 }),
      unit: assertString(row.unit, `action_targets[${index}].unit`),
      countRule,
    };
  });
  for (const id of ACTION_TARGET_IDS) {
    if (!seenIds.has(id)) throw new SchemaError(`action_targets 缺少 ${id}`);
  }
  return definitions;
}

function parseDailyReviewIndexCandidate(frontmatter, body, rel) {
  if (frontmatter.type !== "经营看板" || frontmatter.dashboard_kind !== "daily-review") {
    throw new SchemaError(`${rel} 不是可识别的每日复盘`);
  }
  const date = assertString(frontmatter.date, "date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new SchemaError(`${rel} 的 date 必须是 YYYY-MM-DD`);
  const parsedDate = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
    throw new SchemaError(`${rel} 的 date 不是有效日历日期`);
  }
  if (frontmatter.id !== `daily-review-${date}`) throw new SchemaError(`${rel} 的 id 与 date 不一致`);
  const confirmation = assertEnum(frontmatter.confirmation, "confirmation", CONFIRMATION_STATUSES);
  const expectedStatus = confirmation === "已确认" ? "已确认" : "待确认";
  if (frontmatter.status !== expectedStatus) throw new SchemaError(`${rel} 的 status 必须与 confirmation 一致`);
  const confirmedAt = reviewConfirmedAt(frontmatter, rel);
  if (confirmation === "待人工确认" && confirmedAt !== null) throw new SchemaError(`${rel} 尚未确认，不能包含 confirmed_at`);
  if (confirmation === "已确认" && confirmedAt === null) throw new SchemaError(`${rel} 已确认但缺少 confirmed_at`);
  const expectedHeadings = ["今日完成", "数据与事实", "有效动作", "问题", "今日判断", "明日最重要动作"];
  const lines = body.split(/\r?\n/);
  const headings = lines.filter((line) => /^ {0,3}##[ \t]+/.test(line)).map((line) => line.replace(/^ {0,3}##[ \t]+/, "").trim());
  if (headings.length !== expectedHeadings.length || headings.some((heading, index) => heading !== expectedHeadings[index])) {
    throw new SchemaError(`${rel} 的每日复盘章节结构无效`);
  }
  if (confirmation === "已确认") {
    for (const heading of expectedHeadings) {
      const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
      let end = lines.length;
      for (let index = start + 1; index < lines.length; index += 1) {
        if (/^ {0,3}##[ \t]+/.test(lines[index])) { end = index; break; }
      }
      if (!lines.slice(start + 1, end).join("\n").trim()) throw new SchemaError(`${rel} 的“${heading}”未填写`);
    }
  }
  return { date, confirmation, confirmedAt };
}

function parseTasksFromTasklog(body, sourcePath, updatedAt) {
  const tables = parseMarkdownTable(body);
  const table = tables.find((t) => t.headers.includes("任务") && t.headers.includes("类型"));
  if (!table) throw new SchemaError("TASKLOG 缺少任务清单表格");
  const idx = Object.fromEntries(table.headers.map((h, i) => [h, i]));
  return table.rows.map((row, i) => ({
    id: `vault-task-${sha256(`${sourcePath}\0${row[idx.任务]}\0${i}`).slice(0, 20)}`,
    title: row[idx.任务],
    summary: "",
    status: assertEnum(row[idx.状态], "任务状态", TASK_STATUSES),
    type: assertEnum(row[idx.类型], "任务类型", TASK_TYPES),
    priority: null,
    assignee: row[idx.负责人],
    assignedAgent: null,
    skill: null,
    inputs: [],
    outputs: [],
    verification: null,
    blockedBy: [],
    source: sourcePath,
    dueAt: row[idx.截止时间] === "待确认" ? null : row[idx.截止时间] || null,
    tags: ["TASKLOG"],
    updatedAt,
    demo: false,
    sourceKind: "vault",
    executionMode: "read-only",
  }));
}

function parseTodayTasksFromControl(body) {
  const items = parseNumberListSection(body, "今日三件事");
  return items.map((text, i) => ({
    id: `today-${i + 1}`,
    title: text.replace(/^\s*\[[xX\s]\]\s*/, "").trim(),
    done: /^\s*\[[xX]\]/.test(text),
    linkId: null,
    linkType: null,
  }));
}

function todayInShanghai() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateInShanghai(timestamp) {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) throw new SchemaError(`无效时间: ${timestamp}`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(parsed);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function isKnowledgeInCampaign(item, campaignStartedAt) {
  if (!campaignStartedAt || typeof item?.occurredAt !== "string") return false;
  if (isFullTimestamp(item.occurredAt)) return Date.parse(item.occurredAt) >= Date.parse(campaignStartedAt);
  if (/^\d{4}-\d{2}-\d{2}$/.test(item.occurredAt)) {
    return item.occurredAt > dateInShanghai(campaignStartedAt);
  }
  return false;
}

export function reviewConfirmedAt(frontmatter, rel) {
  const value = frontmatter.confirmed_at;
  // 旧复盘没有确认时刻时仍可进入知识资产，但不能凭创建日期推测完成时间。
  if (value === undefined || value === null || value === "") return null;
  if (!isFullTimestamp(value)) {
    throw new SchemaError(`${rel} 的 confirmed_at 必须是完整 ISO 时间`);
  }
  return value;
}

function parseReviewIndexCandidate(frontmatter, rel) {
  const confirmation = assertEnum(frontmatter.confirmation, "confirmation", CONFIRMATION_STATUSES);
  const expectedStatus = confirmation === "已确认" ? "已确认" : "待确认";
  if (frontmatter.status !== expectedStatus) {
    throw new SchemaError(`${rel} 的 status 必须与 confirmation 一致，期望 ${expectedStatus}`);
  }
  const confirmedAt = reviewConfirmedAt(frontmatter, rel);
  if (confirmation === "待人工确认" && confirmedAt !== null) {
    throw new SchemaError(`${rel} 尚未确认，不能包含 confirmed_at`);
  }
  const topics = assertArray(frontmatter.topics, "topics");
  let kind;
  if (frontmatter.review_kind !== undefined && frontmatter.review_kind !== null && frontmatter.review_kind !== "") {
    kind = assertEnum(frontmatter.review_kind, "review_kind", REVIEW_KINDS);
  } else if (topics.includes("账号拆解") || topics.includes("对标账号")) {
    kind = "account-breakdown";
  } else if (topics.includes("内容复盘")) {
    kind = "content-review";
  } else {
    throw new SchemaError(`${rel} 缺少可识别的 review_kind 或复盘主题`);
  }
  if (!topics.includes(REVIEW_TOPIC_BY_KIND[kind]) && !(kind === "account-breakdown" && topics.includes("对标账号"))) {
    throw new SchemaError(`${rel} 的 topics 与 review_kind 不一致`);
  }
  const relatedContentId = frontmatter.related_content_id === undefined
    || frontmatter.related_content_id === null
    || frontmatter.related_content_id === ""
    ? null
    : assertString(frontmatter.related_content_id, "related_content_id");
  if (relatedContentId && !SAFE_RELATED_CONTENT_ID.test(relatedContentId)) {
    throw new SchemaError(`${rel} 的 related_content_id 不安全`);
  }
  const sourceUrl = frontmatter.source_url === undefined
    || frontmatter.source_url === null
    || frontmatter.source_url === ""
    ? null
    : assertHttpsUrl(frontmatter.source_url, "source_url");
  const derivedFrom = assertArray(frontmatter.derived_from, "derived_from");
  if (derivedFrom.some((value) => typeof value !== "string")) {
    throw new SchemaError(`${rel} 的 derived_from 必须是字符串数组`);
  }
  return { rel, kind, confirmation, confirmedAt, relatedContentId, sourceUrl, derivedFrom, topics };
}

function validateReviewRelationship(candidate, contentById) {
  if (candidate.kind === "account-breakdown") {
    if (!candidate.sourceUrl) throw new SchemaError(`${candidate.rel} 的账号拆解必须提供 https source_url`);
    if (candidate.relatedContentId) throw new SchemaError(`${candidate.rel} 的账号拆解不能关联内容资产`);
    if (candidate.derivedFrom.length !== 0) throw new SchemaError(`${candidate.rel} 未关联内容时 derived_from 必须为空`);
    return;
  }
  if (candidate.relatedContentId) {
    const content = contentById.get(candidate.relatedContentId);
    if (!content) throw new SchemaError(`${candidate.rel} 的 related_content_id 未指向真实已确认内容资产`);
    const extension = path.extname(content.source);
    const stem = content.source.slice(0, -extension.length).split(path.sep).join("/");
    const expected = `[[${stem}]]`;
    if (candidate.derivedFrom.length !== 1 || candidate.derivedFrom[0] !== expected) {
      throw new SchemaError(`${candidate.rel} 的 related_content_id 与 derived_from 不一致`);
    }
    return;
  }
  if (!candidate.sourceUrl) {
    throw new SchemaError(`${candidate.rel} 的内容复盘必须关联真实内容资产或提供 https source_url`);
  }
  if (candidate.derivedFrom.length !== 0) throw new SchemaError(`${candidate.rel} 未关联内容时 derived_from 必须为空`);
}

function parseDailyTaskLinks(raw) {
  if (raw === undefined || raw === null) return new Map();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SchemaError("每日任务 task_links 必须是按任务 ID 索引的对象");
  }
  const safeTaskId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
  const safeLinkId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
  const links = new Map();
  for (const [taskId, value] of Object.entries(raw)) {
    if (!safeTaskId.test(taskId)) throw new SchemaError("每日任务 task_links 包含不安全的任务 ID");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new SchemaError(`每日任务 task_links.${taskId} 必须是对象`);
    }
    const keys = Object.keys(value);
    if (keys.length !== 2 || !keys.includes("type") || !keys.includes("id")) {
      throw new SchemaError(`每日任务 task_links.${taskId} 只能包含 type 和 id`);
    }
    if (!DAILY_TASK_LINK_TYPES.has(value.type)) {
      throw new SchemaError(`每日任务 task_links.${taskId}.type 不受支持`);
    }
    if (typeof value.id !== "string" || !safeLinkId.test(value.id)) {
      throw new SchemaError(`每日任务 task_links.${taskId}.id 不安全`);
    }
    links.set(taskId, { linkType: value.type, linkId: value.id });
  }
  return links;
}

export function parseDailyTasksFromBody(body, date, rawTaskLinks = null) {
  const tasks = [];
  const seenIds = new Set();
  const taskLinks = parseDailyTaskLinks(rawTaskLinks);
  const taskLine = /^\s*-\s*\[([ xX])\]\s+(.+?)\s*$/;
  const marker = /\s*<!--\s*(?:task|task-id):([A-Za-z0-9][A-Za-z0-9_-]{0,79})\s*-->\s*$/;
  const safeId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

  for (const line of body.split(/\r?\n/)) {
    const match = line.match(taskLine);
    if (!match) continue;
    const markerMatch = match[2].match(marker);
    const title = match[2].replace(marker, "").trim();
    const id = markerMatch?.[1] || `today-${date}-${tasks.length + 1}`;
    if (!safeId.test(id)) throw new SchemaError("每日任务 id 不安全");
    if (!title || title.length > 120) throw new SchemaError("每日任务标题必须为 1-120 个字符");
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(title)) throw new SchemaError("每日任务标题包含控制字符");
    if (/[<>]/.test(title)) throw new SchemaError("每日任务标题不能包含 HTML");
    if (title.includes("[[") || title.includes("]]")) throw new SchemaError("每日任务标题不能包含 Obsidian 链接或嵌入");
    if (title.includes("---")) throw new SchemaError("每日任务标题不能包含 frontmatter 分隔符");
    if (seenIds.has(id)) throw new SchemaError(`每日任务 id 重复: ${id}`);
    seenIds.add(id);
    const link = taskLinks.get(id) ?? null;
    tasks.push({
      id,
      title,
      done: match[1].toLowerCase() === "x",
      linkId: link?.linkId ?? null,
      linkType: link?.linkType ?? null,
    });
  }

  if (tasks.length > 3) throw new SchemaError("今日三件事最多只能有 3 条");
  return tasks;
}

export function linkTodayTasks(todayTasks, tasks) {
  const dateTask = tasks.find((task) => task.title.includes("项目") && task.title.includes("日期"));
  return todayTasks.map((task) => {
    if (task.linkId !== null || task.linkType !== null) return task;
    if (dateTask && task.title.includes("项目") && task.title.includes("日期")) {
      return { ...task, linkId: dateTask.id, linkType: "task" };
    }
    return task;
  });
}

function classifyFile(rel, fm, fullText) {
  const sensitivity = fm.sensitivity;
  if (sensitivity === "敏感") {
    return { included: false, review: false, reason: "sensitivity:敏感" };
  }
  if (hasSecret(fullText)) {
    return { included: false, review: false, reason: "secret-detected" };
  }
  const confirmation = fm.confirmation;
  if (confirmation === "待人工确认") {
    return { included: false, review: true, reason: "confirmation:待人工确认" };
  }
  if (confirmation === "已确认") {
    return { included: true, review: false, reason: "confirmation:已确认" };
  }
  throw new SchemaError(`confirmation 字段缺失或未知: ${confirmation}`);
}

export function buildVaultIndex(rootReal) {
  const runtimeSettings = readCockpitSettingsSync(rootReal);
  const { files, warnings } = readAllMarkdownFiles(rootReal, runtimeSettings);

  // 首次 manifest
  const preManifest = computeManifest(rootReal, files);

  const sourceFiles = [];
  const evidence = [];
  let accounts = [];
  let baselineTotal = null;
  let baselineByPlatform = new Map();
  const contents = [];
  const knowledge = [];
  const projectDocuments = [];
  let tasks = [];
  let todayTasks = [];
  let actionTargetDefinitions = [];
  let campaignStartedAt = null;
  const publicationEvents = [];
  const completionEvents = [];
  const knowledgeEvents = [];
  const reviewCandidates = [];
  const dailyReviewEvents = [];
  const reviewItems = [];
  let controlFileBody = null;
  let controlFileRel = null;
  let dailyTasksBody = null;
  let dailyTasksDate = null;
  let dailyTaskLinks = null;
  const evidenceByAccount = new Map();
  const seenIds = new Set();
  const duplicateIds = new Set();

  function requireId(id, rel) {
    if (!id) throw new SchemaError(`${rel} 缺少 id`);
    if (seenIds.has(id)) {
      duplicateIds.add(id);
      throw new SchemaError(`重复 id: ${id}`);
    }
    seenIds.add(id);
    return id;
  }

  const sortedRels = Array.from(files.keys()).sort();

  for (const rel of sortedRels) {
    const { required } = files.get(rel);
    let content;
    let bytes;
    try {
      ({ content, bytes } = readSafeMarkdown(rootReal, rel));
    } catch (err) {
      if (required) throw err;
      warnings.push({ path: rel, reason: err.message });
      continue;
    }
    const fileHash = sha256(content);

    let fm;
    let body;
    try {
      const parsed = parseFrontmatter(content);
      fm = parsed.data;
      body = extractBody(content, parsed.rawFrontmatter);
    } catch (err) {
      if (required) throw err;
      warnings.push({ path: rel, reason: `Frontmatter 错误: ${err.message}` });
      continue;
    }

    let classification = "other";
    let included = false;
    let review = false;
    let reason = "";

    try {
      const outcome = classifyFile(rel, fm, content);
      included = outcome.included;
      review = outcome.review;
      reason = outcome.reason;
    } catch (err) {
      if (required) throw err;
      warnings.push({ path: rel, reason: `分类错误: ${err.message}` });
      continue;
    }

    if (!included && !review) {
      continue;
    }

    // 按路径分类并映射
    try {
      const accountEvidence = rel.startsWith("10-原始材料/04-原始数据/") && rel.endsWith("账号证据.md");
      const criticalGrowthInput = rel === "40-业务资产/01-定位与公司说明/平台账号注册表.md"
        || rel === runtimeSettings.baselineRelativePath
        || rel === COCKPIT_SETTINGS_RELATIVE_PATH.split(path.sep).join("/")
        || accountEvidence;
      if (criticalGrowthInput && !included) {
        throw new SchemaError(`${rel} 是增长计算必需数据，必须已确认且非敏感`);
      }
      if (rel === COCKPIT_SETTINGS_RELATIVE_PATH.split(path.sep).join("/")) {
        classification = "cockpit-settings";
        requireId(fm.id, rel);
      } else if (accountEvidence) {
        classification = "account-evidence";
        const id = requireId(fm.id, rel);
        const platform = normalizePlatformDisplay(assertString(fm.platform, "platform"));
        const accountId = assertString(fm.account_id, "account_id");
        const value = assertInteger(fm.value ?? fm.current_followers, "value");
        const profileUrl = assertHttpsUrl(fm.profile_url, "profile_url");
        evidence.push({
          id,
          platform,
          accountId,
          value,
          asOf: assertString(fm.as_of, "as_of"),
          sourceEvidence: rel,
          profileUrl,
        });
        evidenceByAccount.set(accountId, value);
      } else if (rel.startsWith("10-原始材料/")) {
        classification = "raw-material";
        if (included) {
          const id = requireId(fm.id, rel);
          knowledge.push({
            id,
            title: extractFirstHeading(body),
            summary: toPlainText(body),
            type: "原始材料",
            confirmation: assertEnum(fm.confirmation, "confirmation", CONFIRMATION_STATUSES),
            sensitivity: assertEnum(fm.sensitivity, "sensitivity", SENSITIVITY_LEVELS),
            source: rel,
            topics: assertArray(fm.topics, "topics"),
            updatedAt: assertString(fm.updated_at, "updated_at"),
          });
        } else if (review) {
          reviewItems.push({
            id: requireId(fm.id, rel),
            title: extractFirstHeading(body),
            type: "原始材料",
            reason: "待人工确认",
            summary: toPlainText(body),
            source: rel,
            updatedAt: assertString(fm.updated_at ?? fm.created_at, "updated_at"),
          });
        }
      } else if (rel === "40-业务资产/01-定位与公司说明/平台账号注册表.md") {
        classification = "account-registry";
        requireId(fm.id, rel);
        accounts = parseAccountRegistry(body);
      } else if (rel === runtimeSettings.baselineRelativePath) {
        classification = "follower-baseline";
        requireId(fm.id, rel);
        baselineByPlatform = parseBaselineAccounts(body);
        baselineTotal = [...baselineByPlatform.values()].reduce((sum, value) => sum + value, 0);
      } else if (rel.startsWith("60-数据与看板/05-经营看板/每日复盘/")) {
        classification = "daily-review";
        const id = requireId(fm.id, rel);
        const dailyReview = parseDailyReviewIndexCandidate(fm, body, rel);
        if (included && dailyReview.confirmation === "已确认" && dailyReview.confirmedAt) {
          dailyReviewEvents.push({ id, occurredAt: dailyReview.confirmedAt });
        }
      } else if (rel.startsWith("20-知识资产/")) {
        classification = "knowledge-asset";
        if (included) {
          const id = requireId(fm.id, rel);
          const type = assertEnum(fm.type, "知识类型", ASSET_TYPES);
          const reviewCandidate = type === "复盘" ? parseReviewIndexCandidate(fm, rel) : null;
          knowledge.push({
            id,
            title: extractFirstHeading(body),
            summary: toPlainText(body),
            type,
            confirmation: assertEnum(fm.confirmation, "confirmation", CONFIRMATION_STATUSES),
            sensitivity: assertEnum(fm.sensitivity, "sensitivity", SENSITIVITY_LEVELS),
            source: rel,
            topics: assertArray(fm.topics, "topics"),
            updatedAt: assertString(fm.updated_at, "updated_at"),
          });
          if (reviewCandidate) {
            reviewCandidates.push({ id, ...reviewCandidate });
          } else {
            knowledgeEvents.push({
              type,
              topics: assertArray(fm.topics, "topics"),
              occurredAt: assertString(fm.created_at ?? fm.updated_at, "created_at"),
            });
          }
        } else if (review) {
          const id = requireId(fm.id, rel);
          const type = assertString(fm.type, "type");
          const reviewCandidate = type === "复盘" ? parseReviewIndexCandidate(fm, rel) : null;
          reviewItems.push({
            id,
            title: extractFirstHeading(body),
            type,
            reason: "待人工确认",
            summary: toPlainText(body),
            source: rel,
            updatedAt: assertString(fm.updated_at ?? fm.created_at, "updated_at"),
          });
          if (reviewCandidate) reviewCandidates.push({ id, ...reviewCandidate });
        }
      } else if (rel.startsWith("30-内容资产/")) {
        classification = "content-asset";
        if (included) {
          const id = requireId(fm.id, rel);
          assertEnum(fm.type, "type", ["内容资产"]);
          const status = assertEnum(fm.status, "内容状态", CONTENT_STATUSES);
          const format = mapContentFormat(fm.format);
          const familyId = fm.family_id || id;
          const publicationRecords = parsePublicationRecords(fm.published_records);
          const completedAt = contentCompletedAt(fm, publicationRecords, rel);
          contents.push({
            id,
            familyId,
            title: extractFirstHeading(body),
            summary: toPlainText(body),
            status,
            format,
            channels: parseContentChannels(fm.channels),
            priority: fm.priority === undefined || fm.priority === null
              ? null
              : assertEnum(fm.priority, "priority", PRIORITIES),
            dueAt: fm.due_at || null,
            source: rel,
            nextAction: fm.next_action || "",
            evidenceStatus: deriveEvidenceStatus(publicationRecords),
            tags: assertArray(fm.topics, "topics"),
            updatedAt: assertString(fm.updated_at, "updated_at"),
          });
          publicationEvents.push(...publicationRecords.map((record) => ({ ...record, familyId, format, status })));
          completionEvents.push({ familyId, format, completedAt });
        } else if (review) {
          reviewItems.push({
            id: requireId(fm.id, rel),
            title: extractFirstHeading(body),
            type: assertString(fm.type, "type"),
            reason: "待人工确认",
            summary: toPlainText(body),
            source: rel,
            updatedAt: assertString(fm.updated_at ?? fm.created_at, "updated_at"),
          });
        }
      } else if (rel.startsWith(`${runtimeSettings.projectRelativeDir}/`)) {
        const base = path.basename(rel);
        if (rel.includes("/07-每日任务/") && /^\d{4}-\d{2}-\d{2}-今日三件事\.md$/.test(base)) {
          classification = "daily-tasks";
          if (included) {
            requireId(fm.id, rel);
            assertEnum(fm.type, "type", ["任务日志"]);
            const date = assertString(fm.date, "date");
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new SchemaError("每日任务 date 格式必须为 YYYY-MM-DD");
            assertString(fm.updated_at, "updated_at");
            if (date === todayInShanghai()) {
              dailyTasksBody = body;
              dailyTasksDate = date;
              dailyTaskLinks = fm.task_links ?? null;
            }
          } else if (review) {
            reviewItems.push({
              id: requireId(fm.id, rel),
              title: extractFirstHeading(body),
              type: assertString(fm.type, "type"),
              reason: "待人工确认",
              summary: toPlainText(body),
              source: rel,
              updatedAt: assertString(fm.updated_at ?? fm.created_at, "updated_at"),
            });
          }
        } else if (base === "06-风险与待决策.md") {
          classification = "project-risk";
          if (review) {
            reviewItems.push({
              id: requireId(fm.id, rel),
              title: extractFirstHeading(body),
              type: assertString(fm.type, "type"),
              reason: "待人工确认",
              summary: toPlainText(body),
              source: rel,
              updatedAt: assertString(fm.updated_at ?? fm.created_at, "updated_at"),
            });
          }
        } else {
          classification = "project-document";
          if (included) {
            projectDocuments.push({
              id: requireId(fm.id, rel),
              title: extractFirstHeading(body),
              type: assertString(fm.type, "type"),
              summary: toPlainText(body),
              source: rel,
              updatedAt: assertString(fm.updated_at, "updated_at"),
            });
            if (base === "00-项目总控.md") {
              controlFileBody = body;
              controlFileRel = rel;
            }
            if (base === "01-目标与验收.md") {
              actionTargetDefinitions = parseActionTargetDefinitions(fm.action_targets);
              campaignStartedAt = parseOptionalTimestamp(fm.campaign_started_at, "campaign_started_at");
            }
            if (base === "04-TASKLOG.md") {
              tasks = parseTasksFromTasklog(body, rel, assertString(fm.updated_at, "updated_at"));
              for (const t of tasks) requireId(t.id, rel);
            }
          } else if (review) {
            reviewItems.push({
              id: requireId(fm.id, rel),
              title: extractFirstHeading(body),
              type: assertString(fm.type, "type"),
              reason: "待人工确认",
              summary: toPlainText(body),
              source: rel,
              updatedAt: assertString(fm.updated_at ?? fm.created_at, "updated_at"),
            });
          }
        }
      } else if (rel.startsWith("00-收件箱/")) {
        classification = "inbox-experiment";
        if (review) {
          reviewItems.push({
            id: requireId(fm.id, rel),
            title: extractFirstHeading(body),
            type: assertString(fm.type, "type"),
            reason: "待人工确认",
            summary: toPlainText(body),
            source: rel,
            updatedAt: assertString(fm.updated_at ?? fm.created_at, "updated_at"),
          });
        }
      } else {
        classification = "other";
      }
    } catch (err) {
      if (required) throw err;
      warnings.push({ path: rel, reason: `映射错误: ${err.message}` });
      continue;
    }

    sourceFiles.push({ path: rel, sha256: fileHash, bytes, classification, included, reason });
  }

  // 交叉校验
  if (accounts.length === 0) fail("平台账号注册表未解析");
  if (!Number.isInteger(baselineTotal) || baselineTotal < 0) fail("粉丝基线合计无效");
  accounts = accounts.map((account) => {
    const baselineFollowers = baselineByPlatform.get(account.platform);
    if (baselineFollowers === undefined) fail(`账号 ${account.id} 缺少平台基线`);
    return {
      ...account,
      baselineFollowers,
      followerGrowth: account.currentFollowers - baselineFollowers,
    };
  });
  const currentFollowerTotal = accounts.reduce((sum, account) => sum + account.currentFollowers, 0);
  const currentGrowth = currentFollowerTotal - baselineTotal;
  for (const account of accounts) {
    const evidenceValue = evidenceByAccount.get(account.id);
    if (evidenceValue === undefined) {
      fail(`账号 ${account.id} 缺少证据文件`);
    }
    if (evidenceValue !== account.baselineFollowers) {
      fail(`账号 ${account.id} 证据值 ${evidenceValue} 与基线 ${account.baselineFollowers} 不一致`);
    }
  }

  if (dailyTasksBody && dailyTasksDate) {
    todayTasks = linkTodayTasks(parseDailyTasksFromBody(dailyTasksBody, dailyTasksDate, dailyTaskLinks), tasks);
  } else if (controlFileBody) {
    todayTasks = linkTodayTasks(parseTodayTasksFromControl(controlFileBody), tasks);
  }

  if (actionTargetDefinitions.length !== ACTION_TARGET_IDS.length) {
    fail("行动目标未从 01-目标与验收.md 正确解析");
  }

  const contentById = new Map(
    contents.filter((item) => !duplicateIds.has(item.id)).map((item) => [item.id, item]),
  );
  for (const candidate of reviewCandidates) {
    try {
      validateReviewRelationship(candidate, contentById);
      if (candidate.confirmation === "已确认" && candidate.confirmedAt) {
        knowledgeEvents.push({
          type: "复盘",
          topics: candidate.topics,
          occurredAt: candidate.confirmedAt,
          reviewKind: candidate.kind,
        });
      }
    } catch (error) {
      warnings.push({ path: candidate.rel, reason: `复盘证据错误: ${error.message}` });
    }
  }

  const verifiedCampaignPublications = campaignStartedAt
    ? dedupePublicationEvents(publicationEvents.filter((record) => isPublicationInCampaign(record, campaignStartedAt)))
    : [];
  const completedCampaignAssets = campaignStartedAt
    ? completionEvents.filter((event) => isCompletionInCampaign(event, campaignStartedAt))
    : [];
  const uniqueCompletedFamilies = (format) => new Set(
    completedCampaignAssets.filter((item) => item.format === format).map((item) => item.familyId),
  ).size;
  const accountBreakdownTopics = new Set(["账号拆解", "对标账号"]);
  const isAccountBreakdown = (item) => item.reviewKind === "account-breakdown"
    || item.topics.some((topic) => accountBreakdownTopics.has(topic));
  const eligibleKnowledge = campaignStartedAt
    ? knowledgeEvents.filter((item) => isKnowledgeInCampaign(item, campaignStartedAt))
    : [];
  const actionCounts = {
    completed_article_assets: uniqueCompletedFamilies("文章"),
    completed_video_assets: uniqueCompletedFamilies("短视频口播"),
    platform_publication_records: verifiedCampaignPublications.length,
    confirmed_daily_reviews: campaignStartedAt
      ? dailyReviewEvents.filter((item) => isKnowledgeInCampaign(item, campaignStartedAt)).length
      : 0,
    confirmed_account_breakdowns: eligibleKnowledge.filter(isAccountBreakdown).length,
  };
  const actionTargets = actionTargetDefinitions.map((definition) => {
    const current = actionCounts[definition.countRule];
    return {
      id: definition.id,
      label: definition.label,
      current,
      target: definition.target,
      unit: definition.unit,
      completionRate: definition.target === null ? null : current / definition.target,
    };
  });

  // 二次 manifest（只读操作，应与首次一致）
  const postManifest = computeManifest(rootReal, files);
  const manifestDiff = JSON.stringify(preManifest) !== JSON.stringify(postManifest);
  if (manifestDiff) {
    fail("索引前后 V2 manifest 不一致");
  }

  const growthTarget = runtimeSettings.growthTarget;
  const growthGap = Math.max(0, growthTarget - currentGrowth);
  const growthSummary = {
    baselineFollowers: baselineTotal,
    currentFollowers: currentFollowerTotal,
    gainedFollowers: currentGrowth,
    growthTarget,
    growthGap,
    expectedFollowers: baselineTotal + growthTarget,
    completionRate: Math.min(1, Math.max(0, currentGrowth) / growthTarget),
    asOf: accounts.map((account) => account.asOf).sort().at(-1) ?? runtimeSettings.baselineDate,
    startDate: runtimeSettings.startDate,
    deadline: runtimeSettings.deadline,
    campaignStartedAt,
  };

  const index = {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    dataAsOf: growthSummary.asOf,
    meta: {
      maxFileBytes: MAX_FILE_BYTES,
      parsedFiles: sourceFiles.length,
      normalAssets: sourceFiles.filter((s) => s.included).length,
      reviewItems: reviewItems.length,
      warnings: warnings.length,
    },
    growth: {
      summary: growthSummary,
      accounts,
    },
    actionTargets,
    evidence,
    contents,
    knowledge,
    projectDocuments,
    tasks,
    todayTasks,
    experiments: [],
    reviewItems,
    sourceFiles,
  };

  return { index, preManifest, warnings };
}

export function commitFilesAtomically(entries, { beforeRename } = {}) {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const states = entries.map((entry) => ({
    ...entry,
    tmp: path.join(path.dirname(entry.path), `.tmp-${path.basename(entry.path)}-${token}`),
    backup: path.join(path.dirname(entry.path), `.bak-${path.basename(entry.path)}-${token}`),
    hadOriginal: false,
    committed: false,
  }));

  try {
    for (const state of states) {
      fs.mkdirSync(path.dirname(state.path), { recursive: true });
      fs.writeFileSync(state.tmp, state.content, "utf8");
      fs.chmodSync(state.tmp, state.mode);
    }
    for (const state of states) {
      if (fs.existsSync(state.path)) {
        fs.renameSync(state.path, state.backup);
        state.hadOriginal = true;
      }
    }
    for (let index = 0; index < states.length; index += 1) {
      const state = states[index];
      beforeRename?.(state, index);
      fs.renameSync(state.tmp, state.path);
      state.committed = true;
    }
    for (const state of states) {
      if (state.hadOriginal && fs.existsSync(state.backup)) fs.unlinkSync(state.backup);
    }
  } catch (error) {
    for (const state of states) {
      if (state.committed && fs.existsSync(state.path)) {
        try { fs.unlinkSync(state.path); } catch {}
      }
    }
    for (const state of states) {
      if (state.hadOriginal && fs.existsSync(state.backup)) {
        try { fs.renameSync(state.backup, state.path); } catch {}
      }
      if (fs.existsSync(state.tmp)) {
        try { fs.unlinkSync(state.tmp); } catch {}
      }
    }
    throw error;
  }
}

export function toPublicIndex(index) {
  const publicIndex = structuredClone(index);
  publicIndex.contents = publicIndex.contents.map((item) => ({ ...item, source: `content:${item.id}` }));
  publicIndex.knowledge = publicIndex.knowledge.map((item) => ({ ...item, source: `knowledge:${item.id}` }));
  publicIndex.projectDocuments = publicIndex.projectDocuments.map((item) => ({ ...item, source: `project:${item.id}` }));
  publicIndex.reviewItems = publicIndex.reviewItems.map((item) => ({ ...item, source: `review:${item.id}` }));
  publicIndex.evidence = publicIndex.evidence.map((item) => ({ ...item, sourceEvidence: `evidence:${item.id}` }));
  publicIndex.tasks = publicIndex.tasks.map((item) => ({ ...item, source: `task:${item.id}` }));
  publicIndex.sourceFiles = [];
  publicIndex.meta.parsedFiles = 0;
  publicIndex.meta.normalAssets = 0;
  return publicIndex;
}

function main() {
  if (!fs.existsSync(ALLOWED_ROOT)) {
    fail(`V2 根目录不存在: ${ALLOWED_ROOT}`);
  }
  const rootReal = fs.realpathSync(ALLOWED_ROOT);

  const { index, preManifest, warnings } = buildVaultIndex(rootReal);

  const validationErrors = validateIndexCandidate(index);
  if (validationErrors.length > 0) {
    fail(`候选索引未通过校验：\n  - ${validationErrors.join("\n  - ")}`);
  }

  const indexJson = JSON.stringify(index, null, 2);
  const publicIndex = toPublicIndex(index);
  const publicValidationErrors = validateIndexCandidate(publicIndex);
  if (publicValidationErrors.length > 0) {
    fail(`Public 候选索引未通过校验：\n  - ${publicValidationErrors.join("\n  - ")}`);
  }
  const publicIndexJson = JSON.stringify(publicIndex, null, 2);
  const indexHash = sha256(indexJson);
  const publicIndexHash = sha256(publicIndexJson);

  const report = {
    generatedAt: index.generatedAt,
    schemaVersion: index.schemaVersion,
    dataAsOf: index.dataAsOf,
    canonical: "{RUN_DIR}/index.json",
    publicCopy: "{PROJECT}/public/data/index.json",
    canonicalSha256: indexHash,
    publicSha256: publicIndexHash,
    meta: index.meta,
    v2Manifest: preManifest,
    warnings: warnings.map((w) => ({ path: w.path, reason: w.reason })),
  };

  // 三份产物先完整落临时文件，再整体提交；任一步失败均恢复上一版。
  fs.mkdirSync(LOG_DIR, { recursive: true });
  commitFilesAtomically([
    { path: CANONICAL_INDEX, content: indexJson, mode: 0o600 },
    { path: PUBLIC_INDEX, content: publicIndexJson, mode: 0o644 },
    { path: BUILD_REPORT, content: JSON.stringify(report, null, 2), mode: 0o600 },
  ]);

  console.log(`索引已生成: ${CANONICAL_INDEX}`);
  console.log(`Public 副本: ${PUBLIC_INDEX}`);
  console.log(`构建报告: ${BUILD_REPORT}`);
  console.log(`parsedFiles=${index.meta.parsedFiles}, normalAssets=${index.meta.normalAssets}, reviewItems=${index.meta.reviewItems}, warnings=${index.meta.warnings}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
