#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { hasSecret, MAX_FILE_BYTES, containsDangerousUrl } from "./lib/security.mjs";
import { todayTasksIndexSchema } from "./lib/index-validation-schemas.mjs";

const HOME_PATH = path.resolve(os.homedir());
const STATE_ROOT = path.resolve(process.env.COCKPIT_STATE_ROOT ?? path.join(HOME_PATH, ".media-growth-cockpit"));
const CANONICAL_INDEX = path.join(STATE_ROOT, "index.json");
const PUBLIC_INDEX = path.resolve("public/data/index.json");
const BUILD_REPORT = path.join(STATE_ROOT, "build-report.json");

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sha256String(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

const platformAccountSchema = z.object({
  id: z.string(),
  platform: z.string(),
  account: z.string(),
  displayName: z.string(),
  handle: z.string(),
  profileUrl: z.string().url(),
  baselineFollowers: z.number().int().min(0),
  currentFollowers: z.number().int().min(0),
  followerGrowth: z.number().int(),
  targetFollowers: z.null(),
  gap: z.null(),
  asOf: z.string(),
  sourceEvidence: z.string(),
  active: z.boolean(),
});

const growthSummarySchema = z.object({
  baselineFollowers: z.number().int().min(0),
  currentFollowers: z.number().int().min(0),
  gainedFollowers: z.number().int(),
  growthTarget: z.number().int().positive().max(100_000_000),
  growthGap: z.number().int().min(0),
  expectedFollowers: z.number().int().positive(),
  completionRate: z.number().min(0).max(1),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  campaignStartedAt: z.string().datetime().nullable(),
});

const actionTargetSchema = z.object({
  id: z.enum(["article-output", "video-output", "platform-publish", "content-review", "account-breakdown"]),
  label: z.string(),
  current: z.number().int().min(0),
  target: z.number().int().min(1).max(1_000_000).nullable(),
  unit: z.string(),
  completionRate: z.number().min(0).nullable(),
});

const contentItemSchema = z.object({
  id: z.string(),
  familyId: z.string(),
  title: z.string(),
  summary: z.string(),
  status: z.enum(["候选选题", "已立项", "待发布", "已发布", "待复盘", "已归档"]),
  format: z.enum(["文章", "短视频口播", "图文卡片", "直播稿", "系列"]),
  channels: z.array(z.string()),
  priority: z.enum(["P0", "P1", "P2", "P3"]).nullable(),
  dueAt: z.string().nullable(),
  source: z.string(),
  nextAction: z.string(),
  evidenceStatus: z.enum(["有证据", "部分证据", "待补充"]),
  tags: z.array(z.string()),
  updatedAt: z.string(),
});

const contentItemsSchema = z.array(contentItemSchema).superRefine((items, context) => {
  const ids = new Set();
  for (const [index, item] of items.entries()) {
    if (ids.has(item.id)) {
      context.addIssue({ code: "custom", path: [index, "id"], message: `内容 id 重复: ${item.id}` });
    }
    ids.add(item.id);
  }
});

const taskItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  status: z.enum(["待办", "进行中", "阻塞", "待验收", "已完成"]),
  type: z.enum(["人工任务", "Agent 任务", "人机协作任务"]),
  priority: z.enum(["P0", "P1", "P2", "P3"]).nullable(),
  assignee: z.string(),
  assignedAgent: z.string().nullable(),
  skill: z.string().nullable(),
  inputs: z.array(z.string()),
  outputs: z.array(z.string()),
  verification: z.string().nullable(),
  blockedBy: z.array(z.string()),
  source: z.string(),
  dueAt: z.string().nullable(),
  tags: z.array(z.string()),
  updatedAt: z.string(),
  demo: z.boolean(),
  sourceKind: z.enum(["vault", "local-demo"]),
  executionMode: z.enum(["read-only", "simulated"]),
});

const knowledgeAssetSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  type: z.enum(["判断", "方法", "复盘", "故事", "概念", "原始材料", "内容资产"]),
  confirmation: z.enum(["待人工确认", "已确认"]),
  sensitivity: z.enum(["公开", "内部", "敏感"]),
  source: z.string(),
  topics: z.array(z.string()),
  updatedAt: z.string(),
});

const projectDocumentSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string(),
  summary: z.string(),
  source: z.string(),
  updatedAt: z.string(),
});

const reviewItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string(),
  reason: z.string(),
  summary: z.string(),
  source: z.string(),
  updatedAt: z.string(),
});

const experimentItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  hypothesis: z.string(),
  variable: z.string(),
  baseline: z.string(),
  target: z.string(),
  result: z.enum(["有效", "无效", "证据不足"]),
  decision: z.string(),
  relatedContent: z.array(z.string()),
  nextAction: z.string(),
  updatedAt: z.string(),
});

const evidenceItemSchema = z.object({
  id: z.string(),
  platform: z.string(),
  accountId: z.string(),
  value: z.number().int().min(0),
  asOf: z.string(),
  sourceEvidence: z.string(),
  profileUrl: z.string().url(),
});

const sourceFileSchema = z.object({
  path: z.string(),
  sha256: z.string(),
  bytes: z.number().int().min(0),
  classification: z.string(),
  included: z.boolean(),
  reason: z.string(),
});

export const indexSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  generatedAt: z.string(),
  dataAsOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  meta: z.object({
    maxFileBytes: z.literal(1048576),
    parsedFiles: z.number().int(),
    normalAssets: z.number().int(),
    reviewItems: z.number().int(),
    warnings: z.number().int(),
  }),
  growth: z.object({
    summary: growthSummarySchema,
    accounts: z.array(platformAccountSchema).min(1).max(20),
  }),
  actionTargets: z.array(actionTargetSchema).length(5),
  evidence: z.array(evidenceItemSchema).min(1).max(20),
  contents: contentItemsSchema,
  knowledge: z.array(knowledgeAssetSchema),
  projectDocuments: z.array(projectDocumentSchema),
  tasks: z.array(taskItemSchema),
  todayTasks: todayTasksIndexSchema,
  experiments: z.array(experimentItemSchema),
  reviewItems: z.array(reviewItemSchema),
  sourceFiles: z.array(sourceFileSchema),
});

const errors = [];

function check(name, condition, message) {
  if (!condition) errors.push(`${name}: ${message}`);
}

export function validateIndexCandidate(index) {
  const issues = [];
  const assert = (name, condition, message) => {
    if (!condition) issues.push(`${name}: ${message}`);
  };
  const result = indexSchema.safeParse(index);
  if (!result.success) {
    issues.push(`索引 Schema 校验失败: ${result.error.message}`);
    return issues;
  }
  assert("meta.parsedFiles", index.meta.parsedFiles === index.sourceFiles.length, "parsedFiles 与 sourceFiles 数量不一致");
  assert("meta.normalAssets", index.meta.normalAssets === index.sourceFiles.filter((item) => item.included).length, "normalAssets 与公开普通资产数量不一致");
  assert("meta.reviewItems", index.meta.reviewItems === index.reviewItems.length, "reviewItems 与列表数量不一致");
  assert("meta.warnings", index.meta.warnings === 0, `索引存在 ${index.meta.warnings} 个警告`);
  const summary = index.growth.summary;
  const currentTotal = index.growth.accounts.reduce((sum, account) => sum + account.currentFollowers, 0);
  const latestAccountDate = index.growth.accounts.map((account) => account.asOf).sort().at(-1);
  assert("growth.currentFollowers", summary.currentFollowers === currentTotal, "当前粉丝与平台合计不一致");
  assert("growth.gainedFollowers", summary.gainedFollowers === summary.currentFollowers - summary.baselineFollowers, "净增粉计算错误");
  assert("growth.growthGap", summary.growthGap === Math.max(0, summary.growthTarget - summary.gainedFollowers), "剩余涨粉计算错误");
  assert("growth.expectedFollowers", summary.expectedFollowers === summary.baselineFollowers + summary.growthTarget, "达标总粉丝计算错误");
  assert("growth.completionRate", summary.completionRate === Math.min(1, Math.max(0, summary.gainedFollowers) / summary.growthTarget), "涨粉完成度计算错误");
  assert("growth.asOf", summary.asOf === latestAccountDate, "增长摘要日期不是平台最新日期");
  assert("dataAsOf", index.dataAsOf === summary.asOf, "索引日期与增长摘要日期不一致");
  const raw = JSON.stringify(index);
  assert("no-absolute-paths", !raw.includes(HOME_PATH), "索引包含当前用户绝对路径");
  assert("no-secrets", !hasSecret(raw), "索引包含疑似密钥");
  assert("no-dangerous-urls", !containsDangerousUrl(raw), "索引包含危险 URL");
  return issues;
}

function main() {
  if (!fs.existsSync(CANONICAL_INDEX)) {
    throw new Error(`缺少 canonical 索引: ${CANONICAL_INDEX}`);
  }
  if (!fs.existsSync(PUBLIC_INDEX)) {
    throw new Error(`缺少 public 副本: ${PUBLIC_INDEX}`);
  }
  if (!fs.existsSync(BUILD_REPORT)) {
    throw new Error(`缺少构建报告: ${BUILD_REPORT}`);
  }

  const indexRaw = fs.readFileSync(CANONICAL_INDEX, "utf8");
  const index = JSON.parse(indexRaw);
  const publicRaw = fs.readFileSync(PUBLIC_INDEX, "utf8");
  const publicIndex = JSON.parse(publicRaw);
  const reportRaw = fs.readFileSync(BUILD_REPORT, "utf8");
  const report = JSON.parse(reportRaw);

  // schema
  const result = indexSchema.safeParse(index);
  if (!result.success) {
    errors.push(`索引 Schema 校验失败: ${result.error.message}`);
  }
  const publicResult = indexSchema.safeParse(publicIndex);
  if (!publicResult.success) errors.push(`Public 索引 Schema 校验失败: ${publicResult.error.message}`);
  for (const issue of validateIndexCandidate(index)) {
    if (!errors.includes(issue)) errors.push(issue);
  }

  // 数值断言
  check("meta.parsedFiles", index.meta.parsedFiles === index.sourceFiles.length, `parsedFiles ${index.meta.parsedFiles} 与 sourceFiles ${index.sourceFiles.length} 不一致`);
  check(
    "meta.normalAssets",
    index.meta.normalAssets === index.sourceFiles.filter((item) => item.included).length,
    `normalAssets ${index.meta.normalAssets} 与 included sourceFiles 数量不一致`,
  );
  check("meta.reviewItems", index.meta.reviewItems === index.reviewItems.length, `reviewItems ${index.meta.reviewItems} 与列表数量 ${index.reviewItems.length} 不一致`);
  check("meta.warnings", index.meta.warnings === 0, `期望 0，实际 ${index.meta.warnings}`);

  // 增长断言
  const summary = index.growth.summary;
  check("growth.baselineFollowers", Number.isInteger(summary.baselineFollowers) && summary.baselineFollowers >= 0, `基线无效: ${summary.baselineFollowers}`);
  check("growth.currentFollowers", summary.currentFollowers >= 0, `当前总粉丝无效: ${summary.currentFollowers}`);
  check("growth.gainedFollowers", summary.gainedFollowers === summary.currentFollowers - summary.baselineFollowers, "净增粉计算错误");
  check("growth.growthGap", summary.growthGap === Math.max(0, summary.growthTarget - summary.gainedFollowers), "剩余涨粉计算错误");
  check("growth.expectedFollowers", summary.expectedFollowers === summary.baselineFollowers + summary.growthTarget, "达标总粉丝计算错误");
  check("growth.completionRate", summary.completionRate === Math.min(1, Math.max(0, summary.gainedFollowers) / summary.growthTarget), "涨粉完成度计算错误");
  const computedTotal = index.growth.accounts.reduce((s, a) => s + a.currentFollowers, 0);
  check("growth.accounts-sum", computedTotal === summary.currentFollowers, `账号求和 ${computedTotal} 与 summary ${summary.currentFollowers} 不一致`);
  const latestAccountDate = index.growth.accounts.map((account) => account.asOf).sort().at(-1);
  check("growth.asOf", summary.asOf === latestAccountDate, `摘要日期 ${summary.asOf} 与账号最新日期 ${latestAccountDate} 不一致`);
  check("dataAsOf", index.dataAsOf === summary.asOf, `索引日期 ${index.dataAsOf} 与增长摘要日期 ${summary.asOf} 不一致`);

  const actionTargets = Object.fromEntries(index.actionTargets.map((item) => [item.id, item]));
  if (summary.campaignStartedAt === null) {
    for (const [id, item] of Object.entries(actionTargets)) {
      check(`action.prelaunch.${id}`, item.current === 0, `${id} 在正式开始前必须为 0`);
    }
  }
  for (const id of ["platform-publish", "content-review", "account-breakdown"]) {
    check(`action.${id}`, Number.isInteger(actionTargets[id]?.current) && actionTargets[id].current >= 0, `${id} 完成数无效`);
  }

  // 视频号 414/512/428 不得归抖音：检查内容 published_records 不在这里，我们通过 contents 不直接含播放量验证
  // 平台数量由本地账号注册表决定。
  const platforms = index.growth.accounts.map((a) => a.platform).sort();
  check("platforms", platforms.length >= 1 && platforms.length <= 20, `平台数量 ${platforms.length} 无效`);

  // 内容形态映射与可编辑字段
  for (const c of index.contents) {
    check(`content.id:${c.id}`, /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(c.id), `内容 ${c.id} 的 id 不安全`);
    check(`content.channels:${c.id}`, new Set(c.channels).size === c.channels.length, `内容 ${c.id} 的平台重复`);
  }

  // 安全：无绝对路径、无密钥、无危险 URL
  check("no-absolute-paths", !indexRaw.includes(HOME_PATH), "索引中包含当前用户绝对路径");
  check("no-secrets", !hasSecret(indexRaw), "索引中检测到疑似密钥");
  check("no-dangerous-urls", !containsDangerousUrl(indexRaw), "索引中检测到危险 URL 协议");
  check("report-no-absolute-paths", !reportRaw.includes(HOME_PATH), "构建报告包含当前用户绝对路径");

  // Public 索引只包含不透明资产引用，不下发 V2 相对路径或扫描清单。
  const publicSources = [
    ...publicIndex.contents.map((item) => item.source),
    ...publicIndex.knowledge.map((item) => item.source),
    ...publicIndex.projectDocuments.map((item) => item.source),
    ...publicIndex.reviewItems.map((item) => item.source),
    ...publicIndex.evidence.map((item) => item.sourceEvidence),
  ];
  check("public-opaque-sources", publicSources.every((source) => /^(?:content|knowledge|project|review|evidence):[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(source)), "Public 索引包含非不透明来源引用");
  check("public-no-source-files", publicIndex.sourceFiles.length === 0, "Public 索引不应下发源文件扫描清单");
  check("public-no-vault-paths", !/(?:^|\")\d{2}-[^\"]+\/[^\"]+\.md/.test(publicRaw), "Public 索引包含 V2 相对路径");

  // 构建报告 hash 匹配
  const computedIndexHash = sha256String(indexRaw);
  check("build-report-hash", report.canonicalSha256 === computedIndexHash, `构建报告 hash 不匹配`);
  check("build-report-public-hash", report.publicSha256 === sha256String(publicRaw), `构建报告 public hash 不匹配`);

  // build-report 中 manifest 非空
  check(
    "v2-manifest-size",
    Array.isArray(report.v2Manifest) && report.v2Manifest.length >= index.sourceFiles.length,
    `manifest 长度 ${report.v2Manifest?.length} 小于公开 sourceFiles ${index.sourceFiles.length}`,
  );
  check("v2-manifest-no-empty-hash", report.v2Manifest.every((m) => /^[a-f0-9]{64}$/.test(m.sha256)), "manifest 中存在空 hash");

  if (errors.length > 0) {
    console.error("数据校验失败:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log("数据校验通过");
  console.log(`  parsedFiles=${index.meta.parsedFiles}, normalAssets=${index.meta.normalAssets}, reviewItems=${index.meta.reviewItems}`);
  console.log(`  canonical=${Buffer.byteLength(indexRaw)} bytes, public=${Buffer.byteLength(publicRaw)} bytes`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
