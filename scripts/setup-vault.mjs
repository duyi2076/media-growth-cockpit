#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { stringify as stringifyYaml } from "yaml";
import {
  COCKPIT_SETTINGS_RELATIVE_PATH,
  cockpitSettingsSchema,
  createCockpitSettingsStore,
} from "../server/cockpit-settings-store.mjs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const SUPPORTED_PLATFORMS = ["小红书", "公众号", "B 站", "抖音", "视频号", "X"];
const platformSchema = z.string()
  .transform((value) => value === "B站" ? "B 站" : value)
  .pipe(z.enum(SUPPORTED_PLATFORMS, {
    error: `平台仅支持: ${SUPPORTED_PLATFORMS.join("、")}`,
  }));
const cleanText = (label, max) => z.string().trim().min(1).max(max)
  .refine((value) => !/[\r\n\0|<>]/.test(value), `${label}包含不安全字符`);
const accountSchema = z.object({
  id: z.string().regex(ID_RE),
  platform: platformSchema,
  displayName: cleanText("显示名", 80),
  handle: cleanText("账号", 100),
  profileUrl: z.string().url().refine((value) => value.startsWith("https://"), "主页链接必须使用 https"),
  baselineFollowers: z.number().int().min(0).max(100_000_000),
  currentFollowers: z.number().int().min(0).max(100_000_000),
  asOf: z.string().regex(DATE_RE),
  sourceEvidence: cleanText("数据来源", 160),
  active: z.boolean().default(true),
}).strict().refine((value) => value.currentFollowers >= 0, "当前粉丝无效");
const accountsSchema = z.array(accountSchema).min(1).max(SUPPORTED_PLATFORMS.length);

const inputSchema = z.object({
  productName: z.string(),
  ownerName: z.string(),
  creatorPositioning: z.string(),
  campaignName: z.string(),
  growthTarget: z.number(),
  startDate: z.union([z.string().regex(DATE_RE), z.null()]).default(null),
  deadline: z.union([z.string().regex(DATE_RE), z.null()]).default(null),
  projectRelativeDir: z.string().default("50-进行中项目/自媒体增长计划"),
  baselineDate: z.string().regex(DATE_RE),
  baselineRelativePath: z.string().optional(),
  accounts: accountsSchema,
  actionTargets: z.object({
    articles: z.number().int().min(1).max(1_000_000).nullable().default(null),
    videos: z.number().int().min(1).max(1_000_000).nullable().default(null),
    publications: z.number().int().min(1).max(1_000_000).nullable().default(null),
    dailyReviews: z.number().int().min(1).max(1_000_000).nullable().default(null),
    accountBreakdowns: z.number().int().min(1).max(1_000_000).nullable().default(null),
  }).default({}),
}).strict().superRefine((value, context) => {
  const ids = new Set(value.accounts.map((item) => item.id));
  const platforms = new Set(value.accounts.map((item) => item.platform));
  if (ids.size !== value.accounts.length) context.addIssue({ code: "custom", path: ["accounts"], message: "账号 ID 不能重复" });
  if (platforms.size !== value.accounts.length) context.addIssue({ code: "custom", path: ["accounts"], message: "当前版本每个平台只能初始化一个账号" });
});

function usage() {
  return "用法: V2_VAULT_ROOT=/path/to/vault npm run setup:vault -- --config ./setup.json";
}

function yaml(frontmatter, body) {
  return `---\n${stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${body.trim()}\n`;
}

function wikilinkFrom(relativePath) {
  return `[[${path.basename(relativePath, ".md")}]]`;
}

async function lstatOrNull(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function resolveInsideRoot(root, relativePath) {
  if (
    typeof relativePath !== "string"
    || !relativePath
    || path.isAbsolute(relativePath)
    || relativePath.includes("\\")
    || relativePath.includes("\0")
    || relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`初始化路径不是安全的 Vault 相对路径: ${relativePath}`);
  }
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`初始化路径超出 Vault 根目录: ${relativePath}`);
  }
  return target;
}

async function assertRootSafe(root) {
  const stat = await lstatOrNull(root);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Vault 根目录不存在、不是目录或为软链接");
  }
}

async function ensureRoot(root) {
  const existing = await lstatOrNull(root);
  if (existing) {
    await assertRootSafe(root);
    return;
  }

  const missing = [];
  let ancestor = root;
  let ancestorStat = null;
  while (!ancestorStat) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("无法找到可安全创建 Vault 的父目录");
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
    ancestorStat = await lstatOrNull(ancestor);
  }
  if (!ancestorStat.isDirectory() || ancestorStat.isSymbolicLink()) {
    throw new Error("Vault 父路径包含软链接或非目录节点");
  }

  let current = ancestor;
  for (const segment of missing) {
    current = path.join(current, segment);
    try {
      await fs.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const stat = await lstatOrNull(current);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Vault 创建路径包含软链接或非目录节点");
    }
  }
  await assertRootSafe(root);
}

async function assertDirectorySafe(root, target) {
  await assertRootSafe(root);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("初始化目录超出 Vault 根目录");
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstatOrNull(current);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("初始化路径包含软链接或非目录父节点");
    }
  }

  const [rootReal, targetReal] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
  const expectedReal = path.resolve(rootReal, relative);
  if (targetReal !== expectedReal) throw new Error("初始化目录解析后超出 Vault 根目录或经过软链接");
}

async function ensureSafeDirectory(root, target) {
  await assertRootSafe(root);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("初始化目录超出 Vault 根目录");
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat = await lstatOrNull(current);
    if (!stat) {
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      stat = await lstatOrNull(current);
    }
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("初始化路径包含软链接或非目录父节点");
    }
  }
  await assertDirectorySafe(root, target);
}

async function assertTargetAvailable(root, filePath, relativePath) {
  await assertRootSafe(root);
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`初始化文件超出 Vault 根目录: ${relativePath}`);
  }
  const segments = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const stat = await lstatOrNull(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error(`初始化路径包含软链接: ${relativePath}`);
    if (index < segments.length - 1) {
      if (!stat.isDirectory()) throw new Error(`初始化路径包含非目录父节点: ${relativePath}`);
      continue;
    }
    throw new Error(`为避免覆盖已有资产，初始化已停止: ${relativePath}`);
  }
}

async function assertCreatedFileSafe(root, filePath, relativePath) {
  await assertDirectorySafe(root, path.dirname(filePath));
  const stat = await lstatOrNull(filePath);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error(`初始化目标不是安全的普通文件: ${relativePath}`);
  }
  const [rootReal, fileReal] = await Promise.all([fs.realpath(root), fs.realpath(filePath)]);
  const expectedReal = path.resolve(rootReal, path.relative(root, filePath));
  if (fileReal !== expectedReal) throw new Error(`初始化文件解析后超出 Vault 根目录: ${relativePath}`);
}

async function writeNew(root, relativePath, contents) {
  const filePath = resolveInsideRoot(root, relativePath);
  const parent = path.dirname(filePath);
  await ensureSafeDirectory(root, parent);
  await assertTargetAvailable(root, filePath, relativePath);
  await assertDirectorySafe(root, parent);

  let created = false;
  try {
    await fs.writeFile(filePath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    created = true;
    await assertCreatedFileSafe(root, filePath, relativePath);
    return filePath;
  } catch (error) {
    if (created) await fs.unlink(filePath).catch(() => {});
    throw error;
  }
}

function actionRows(targets) {
  return [
    ["article-output", "文章", targets.articles, "篇", "completed_article_assets"],
    ["video-output", "视频", targets.videos, "条", "completed_video_assets"],
    ["platform-publish", "发布", targets.publications, "次", "platform_publication_records"],
    ["content-review", "复盘", targets.dailyReviews, "次", "confirmed_daily_reviews"],
    ["account-breakdown", "账号拆解", targets.accountBreakdowns, "个", "confirmed_account_breakdowns"],
  ];
}

export async function setupVault({ root, config }) {
  const accounts = accountsSchema.parse(config.accounts);
  const baselineRelativePath = config.baselineRelativePath
    ?? `60-数据与看板/01-内容数据/${config.baselineDate}-平台粉丝基线.md`;
  const settings = cockpitSettingsSchema.parse({
    productName: config.productName,
    ownerName: config.ownerName,
    creatorPositioning: config.creatorPositioning,
    campaignName: config.campaignName,
    growthTarget: config.growthTarget,
    startDate: config.startDate,
    deadline: config.deadline,
    projectRelativeDir: config.projectRelativeDir,
    baselineDate: config.baselineDate,
    baselineRelativePath,
  });
  const resolvedRoot = path.resolve(root);
  await ensureRoot(resolvedRoot);

  const evidenceDir = "10-原始材料/04-原始数据";
  const registryRelativePath = "40-业务资产/01-定位与公司说明/平台账号注册表.md";
  const goalRelativePath = `${settings.projectRelativeDir}/01-目标与验收.md`;
  const evidenceFiles = accounts.map((account) => ({
    account,
    relativePath: `${evidenceDir}/${config.baselineDate}-${account.id}-账号证据.md`,
  }));
  const reserved = [
    COCKPIT_SETTINGS_RELATIVE_PATH,
    baselineRelativePath,
    registryRelativePath,
    goalRelativePath,
    ...evidenceFiles.map((item) => item.relativePath),
  ];
  for (const relativePath of reserved) {
    const filePath = resolveInsideRoot(resolvedRoot, relativePath);
    await assertTargetAvailable(resolvedRoot, filePath, relativePath);
  }

  const directories = [
    "00-收件箱/待确认文件",
    evidenceDir,
    "20-知识资产/03-复盘",
    "30-内容资产/00-选题池",
    "60-数据与看板/04-实验记录",
    "60-数据与看板/05-经营看板/每日复盘",
    `${settings.projectRelativeDir}/07-每日任务`,
  ];
  for (const relativePath of directories) {
    await ensureSafeDirectory(resolvedRoot, resolveInsideRoot(resolvedRoot, relativePath));
  }

  const createdFiles = [];
  const writeTracked = async (relativePath, contents) => {
    const filePath = await writeNew(resolvedRoot, relativePath, contents);
    createdFiles.push(filePath);
  };

  try {
    const derivedLinks = evidenceFiles.map((item) => wikilinkFrom(item.relativePath));
    for (const { account, relativePath } of evidenceFiles) {
      await writeTracked(relativePath, yaml({
      id: `evidence-${account.id}-${config.baselineDate}`,
      type: "原始数据",
      status: "已提炼",
      created_at: config.baselineDate,
      updated_at: config.baselineDate,
      source: account.sourceEvidence,
      topics: [account.platform, "粉丝基线", "平台账号"],
      sensitivity: "内部",
      origin_owner: settings.ownerName,
      processed_by: "人机协作",
      confirmation: "已确认",
      derived_from: [],
      related_assets: ["[[平台账号注册表]]", wikilinkFrom(baselineRelativePath)],
      platform: account.platform,
      account_id: account.id,
      metric: "followers",
      value: account.baselineFollowers,
      current_followers: account.baselineFollowers,
      period: "snapshot",
      as_of: config.baselineDate,
      profile_url: account.profileUrl,
      source_evidence: account.sourceEvidence,
      }, `# ${account.platform}账号基线证据\n\n${account.sourceEvidence}`));
    }

  const registryRows = accounts.map((account) => `| ${account.id} | ${account.platform} | ${account.displayName} | ${account.handle} | ${account.profileUrl} | ${account.currentFollowers} | ${account.asOf} | ${account.sourceEvidence} | ${account.active} |`).join("\n");
    await writeTracked(registryRelativePath, yaml({
    id: "media-growth-platform-accounts",
    type: "定位与公司说明",
    status: "已确认",
    created_at: config.baselineDate,
    updated_at: config.baselineDate,
    source: "首次初始化配置",
    topics: ["平台账号", "增长驾驶舱"],
    sensitivity: "内部",
    origin_owner: settings.ownerName,
    processed_by: "人机协作",
    confirmation: "已确认",
    derived_from: derivedLinks,
    related_assets: [wikilinkFrom(baselineRelativePath)],
  }, `# 平台账号注册表\n\n| account_id | platform | display_name | handle | profile_url | current_followers | as_of | source_evidence | active |\n|---|---|---|---|---|---:|---|---|---|\n${registryRows}`));

  const baselineTotal = accounts.reduce((sum, account) => sum + account.baselineFollowers, 0);
  const baselineRows = accounts.map((account) => `| ${account.platform} | ${account.displayName} | ${account.baselineFollowers} | ${account.profileUrl} | ${account.sourceEvidence} |`).join("\n");
    await writeTracked(baselineRelativePath, yaml({
    id: `media-growth-baseline-${config.baselineDate}`,
    type: "粉丝基线",
    status: "已确认",
    created_at: config.baselineDate,
    updated_at: config.baselineDate,
    source: "首次初始化配置",
    topics: ["粉丝基线", "增长目标"],
    sensitivity: "内部",
    origin_owner: settings.ownerName,
    processed_by: "人机协作",
    confirmation: "已确认",
    derived_from: derivedLinks,
    related_assets: ["[[平台账号注册表]]"],
  }, `# ${config.baselineDate} 平台粉丝基线\n\n| 平台 | 账号 | 粉丝数 | 主页链接 | 数据来源 |\n|---|---|---:|---|---|\n${baselineRows}\n| **合计** | | **${baselineTotal}** | | |`));

  const rows = actionRows(config.actionTargets);
  const actionTargetMetadata = rows.map(([id, label, target, unit, countRule]) => ({ id, label, target, unit, count_rule: countRule }));
  const tableRows = rows.map(([, label, target, unit, countRule]) => `| ${label} | ${target === null ? "待填写" : `${target} ${unit}`} | ${countRule} |`).join("\n");
    await writeTracked(goalRelativePath, yaml({
    id: "media-growth-project-goals",
    type: "项目目标",
    status: "进行中",
    created_at: config.baselineDate,
    updated_at: config.baselineDate,
    source: "驾驶舱首次初始化",
    topics: ["增长目标", "行动目标"],
    sensitivity: "内部",
    origin_owner: settings.ownerName,
    processed_by: "人机协作",
    confirmation: "已确认",
    derived_from: [],
    related_assets: [wikilinkFrom(baselineRelativePath)],
    action_targets: actionTargetMetadata,
    campaign_started_at: null,
  }, `# 目标与验收\n\n## 行动目标\n\n| 动作 | 目标 | 完成数来源 |\n|---|---:|---|\n${tableRows}`));

    const settingsStore = createCockpitSettingsStore({ root: resolvedRoot, afterWrite: async () => {} });
    await settingsStore.write(settings, null);
    return { root: resolvedRoot, settings, filesCreated: reserved.length };
  } catch (error) {
    await Promise.allSettled(createdFiles.reverse().map((filePath) => fs.unlink(filePath)));
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const configIndex = args.indexOf("--config");
  if (configIndex === -1 || !args[configIndex + 1]) throw new Error(usage());
  const root = process.env.V2_VAULT_ROOT ?? process.env.OBSIDIAN_VAULT_ROOT;
  if (!root) throw new Error(`缺少 V2_VAULT_ROOT。${usage()}`);
  const configPath = path.resolve(args[configIndex + 1]);
  const parsed = inputSchema.safeParse(JSON.parse(await fs.readFile(configPath, "utf8")));
  if (!parsed.success) throw new Error(`初始化配置无效:\n${parsed.error.message}`);
  const result = await setupVault({ root, config: parsed.data });
  console.log(`V2 初始化完成: ${result.root}`);
  console.log(`已创建 ${result.filesCreated} 个权威文件，可执行 npm run index && npm run validate:data。`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
