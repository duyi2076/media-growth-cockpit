import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { hasSecret } from "../scripts/lib/security.mjs";
import { readCockpitSettingsSync } from "./cockpit-settings-store.mjs";
import { createSafeStatePaths } from "./lib/safe-state-paths.mjs";
import { runWithSharedWriteQueue } from "./lib/shared-write-queue.mjs";

export const DAILY_TASKS_RELATIVE_DIR = path.join(
  "50-进行中项目",
  "自媒体增长计划",
  "07-每日任务",
);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const LINK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
export const DAILY_TASK_LINK_TYPES = Object.freeze([
  "topic",
  "content",
  "content-review",
  "account-breakdown",
  "daily-review",
  "task",
]);
const HASH_RE = /^[a-f0-9]{64}$/;
const TASK_MARKER_RE = /\s*<!--\s*(?:task|task-id):([A-Za-z0-9][A-Za-z0-9_-]{0,79})\s*-->\s*$/;
const CHECKBOX_RE = /^\s*-\s*\[([ xX])\]\s+(.+?)\s*$/;
const TASKS_START_MARKER = "<!-- cockpit:tasks:start -->";
const TASKS_END_MARKER = "<!-- cockpit:tasks:end -->";

const titleSchema = z
  .string()
  .trim()
  .min(1, "任务标题不能为空")
  .max(120, "任务标题不能超过 120 个字符")
  .refine((value) => !/[\r\n\0]/.test(value), "任务标题必须是单行文字")
  .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value), "任务标题包含控制字符")
  .refine((value) => !/[<>]/.test(value), "任务标题不能包含 HTML")
  .refine((value) => !value.includes("[[") && !value.includes("]]"), "任务标题不能包含 Obsidian 链接或嵌入")
  .refine((value) => !value.includes("---"), "任务标题不能包含 frontmatter 分隔符");

const taskLinkSchema = z.object({
  type: z.enum(DAILY_TASK_LINK_TYPES),
  id: z.string().regex(LINK_ID_RE, "关联资产 ID 不安全"),
}).strict();

const taskInputSchema = z.object({
  id: z.string().regex(TASK_ID_RE, "任务 ID 不安全"),
  title: titleSchema,
  done: z.boolean(),
  linkId: z.union([z.string().regex(LINK_ID_RE, "关联资产 ID 不安全"), z.null()]).optional().default(null),
  linkType: z.union([z.enum(DAILY_TASK_LINK_TYPES), z.null()]).optional().default(null),
}).strict().superRefine((task, context) => {
  if ((task.linkId === null) !== (task.linkType === null)) {
    context.addIssue({
      code: "custom",
      path: [task.linkId === null ? "linkId" : "linkType"],
      message: "linkId 与 linkType 必须同时为空或同时存在",
    });
  }
}).transform(({ id, title, done, linkId, linkType }) => ({ id, title, done, linkId, linkType }));

export const dailyTasksInputSchema = z.array(taskInputSchema).max(3, "今日任务最多 3 条").superRefine((tasks, context) => {
  const ids = new Set();
  for (const [index, task] of tasks.entries()) {
    if (ids.has(task.id)) {
      context.addIssue({
        code: "custom",
        path: [index, "id"],
        message: "任务 ID 不能重复",
      });
    }
    ids.add(task.id);
  }
});

export class DailyTasksValidationError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "DailyTasksValidationError";
  }
}

export class DailyTasksSecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = "DailyTasksSecurityError";
  }
}

export class DailyTasksConflictError extends Error {
  constructor(current) {
    super("任务文件已经被其他操作修改，请加载最新内容后重试");
    this.name = "DailyTasksConflictError";
    this.current = current;
  }
}

export class DailyTasksCommitError extends Error {
  constructor(message, { cause, rollbackError } = {}) {
    super(message, { cause });
    this.name = "DailyTasksCommitError";
    this.rollbackError = rollbackError;
  }
}

export function validateDate(date) {
  if (typeof date !== "string" || !DATE_RE.test(date)) {
    throw new DailyTasksValidationError("日期必须是 YYYY-MM-DD 格式");
  }
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new DailyTasksValidationError("日期不是有效的公历日期");
  }
  return date;
}

export function shanghaiDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function toPublicTask(task) {
  return {
    id: task.id,
    title: task.title,
    done: task.done,
    linkId: task.linkId,
    linkType: task.linkType,
  };
}

function parseTaskLinks(frontmatter) {
  const raw = frontmatter.task_links;
  if (raw === undefined || raw === null) return new Map();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DailyTasksValidationError("task_links 必须是按任务 ID 索引的对象");
  }
  const links = new Map();
  for (const [taskId, value] of Object.entries(raw)) {
    if (!TASK_ID_RE.test(taskId)) {
      throw new DailyTasksValidationError("task_links 包含不安全的任务 ID");
    }
    const parsed = taskLinkSchema.safeParse(value);
    if (!parsed.success) {
      throw new DailyTasksValidationError(`task_links.${taskId} 无效`, parsed.error);
    }
    links.set(taskId, parsed.data);
  }
  return links;
}

function serializeTaskLinks(tasks) {
  return Object.fromEntries(tasks
    .filter((task) => task.linkId !== null && task.linkType !== null)
    .map((task) => [task.id, { type: task.linkType, id: task.linkId }]));
}

function splitFrontmatter(markdown) {
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) {
    return { frontmatter: {}, body: markdown };
  }
  const normalized = markdown.replace(/\r\n/g, "\n");
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) {
    throw new DailyTasksValidationError("每日任务文件的 frontmatter 未闭合");
  }
  const raw = normalized.slice(4, end);
  let frontmatter;
  try {
    frontmatter = parseYaml(raw) ?? {};
  } catch (error) {
    throw new DailyTasksValidationError("每日任务文件的 frontmatter 无法解析", error);
  }
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new DailyTasksValidationError("每日任务文件的 frontmatter 必须是对象");
  }
  return { frontmatter, body: normalized.slice(end + 5) };
}

function findTaskSection(body, date) {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const starts = lines.flatMap((line, index) => line.trim() === TASKS_START_MARKER ? [index] : []);
  const ends = lines.flatMap((line, index) => line.trim() === TASKS_END_MARKER ? [index] : []);
  if (starts.length || ends.length) {
    if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) {
      throw new DailyTasksValidationError("每日任务受控区块标记损坏");
    }
    return { lines, start: starts[0] + 1, end: ends[0], markerStart: starts[0], markerEnd: ends[0] };
  }

  const heading = `# ${date} 今日三件事`;
  const headingIndex = lines.findIndex((line) => (
    date
      ? line.trim() === heading
      : /^# \d{4}-\d{2}-\d{2} 今日三件事$/.test(line.trim())
  ));
  const start = headingIndex === -1 ? 0 : headingIndex + 1;
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (/^#{1,6}\s+/.test(lines[index].trim())) {
      end = index;
      break;
    }
  }
  return { lines, start, end, markerStart: null, markerEnd: null };
}

export function parseDailyTasksMarkdown(markdown) {
  if (typeof markdown !== "string") {
    throw new DailyTasksValidationError("每日任务文件必须是文本");
  }
  const { frontmatter, body } = splitFrontmatter(markdown);
  const taskLinks = parseTaskLinks(frontmatter);
  const tasks = [];
  const section = findTaskSection(body, String(frontmatter.date ?? ""));
  for (const line of section.lines.slice(section.start, section.end)) {
    const checkbox = line.match(CHECKBOX_RE);
    if (!checkbox) continue;
    const marker = checkbox[2].match(TASK_MARKER_RE);
    const title = checkbox[2].replace(TASK_MARKER_RE, "").trim();
    const manualId = `manual-${sha256(`${frontmatter.date ?? "unknown"}:${tasks.length}:${title}`).slice(0, 20)}`;
    const id = marker?.[1] ?? manualId;
    const link = taskLinks.get(id) ?? null;
    tasks.push({
      id,
      title,
      done: checkbox[1].toLowerCase() === "x",
      linkId: link?.id ?? null,
      linkType: link?.type ?? null,
    });
  }
  const validated = dailyTasksInputSchema.safeParse(tasks);
  if (!validated.success) {
    throw new DailyTasksValidationError("每日任务文件包含不安全或无效的任务", validated.error);
  }
  return { frontmatter, body, tasks: validated.data };
}

function mergeTaskLines(body, date, taskLines) {
  const managedBlock = [TASKS_START_MARKER, ...taskLines, TASKS_END_MARKER];
  if (typeof body !== "string" || !body.trim()) {
    return `\n# ${date} 今日三件事\n\n${managedBlock.join("\n")}\n`;
  }
  const section = findTaskSection(body, date);
  if (section.markerStart !== null && section.markerEnd !== null) {
    section.lines.splice(
      section.markerStart,
      section.markerEnd - section.markerStart + 1,
      ...managedBlock,
    );
    return section.lines.join("\n");
  }

  const taskIndexes = [];
  for (let index = section.start; index < section.end; index += 1) {
    if (CHECKBOX_RE.test(section.lines[index])) taskIndexes.push(index);
  }
  const taskIndexSet = new Set(taskIndexes);
  const merged = section.lines.filter((_, index) => !taskIndexSet.has(index));

  let insertionIndex;
  if (taskIndexes.length > 0) {
    insertionIndex = taskIndexes[0];
  } else {
    insertionIndex = section.start;
    if (merged[insertionIndex] === "") insertionIndex += 1;
  }
  merged.splice(insertionIndex, 0, ...managedBlock);
  return merged.join("\n");
}

export function serializeDailyTasksMarkdown({ date, frontmatter = {}, body = null, tasks, ownerName = "使用者" }) {
  validateDate(date);
  const validated = dailyTasksInputSchema.safeParse(tasks);
  if (!validated.success) {
    throw new DailyTasksValidationError("今日任务数据无效", validated.error);
  }
  const metadata = Object.assign({
    id: `daily-tasks-${date}`,
    type: "任务日志",
    status: "进行中",
    created_at: date,
    updated_at: date,
    date,
    source: "驾驶舱与 Obsidian 双向同步",
    topics: ["自媒体", "增长", "每日执行"],
    sensitivity: "内部",
    origin_owner: ownerName,
    processed_by: "人机协作",
    confirmation: "已确认",
    derived_from: ["[[00-项目总控]]"],
    related_assets: ["[[04-TASKLOG]]"],
  }, frontmatter, {
    id: `daily-tasks-${date}`,
    type: "任务日志",
    updated_at: date,
    date,
    sensitivity: "内部",
    confirmation: "已确认",
    task_links: serializeTaskLinks(validated.data),
  });
  const yaml = stringifyYaml(metadata, { lineWidth: 0 }).trimEnd();
  const taskLines = validated.data.map(
    (task) => `- [${task.done ? "x" : " "}] ${task.title} <!-- task:${task.id} -->`,
  );
  return `---\n${yaml}\n---\n${mergeTaskLines(body, date, taskLines)}`;
}

function assertInsideRoot(root, target) {
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new DailyTasksSecurityError("目标路径超出 V2 白名单目录");
}

async function lstatOrNull(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertNoSymlinks(root, target, { allowMissing = false } = {}) {
  assertInsideRoot(root, target);
  const rootStat = await lstatOrNull(root);
  if (!rootStat) {
    if (allowMissing) return;
    throw new DailyTasksSecurityError("V2 根目录不存在");
  }
  if (rootStat.isSymbolicLink()) {
    throw new DailyTasksSecurityError("V2 根目录不能是软链接");
  }
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstatOrNull(current);
    if (!stat) {
      if (allowMissing) continue;
      throw new DailyTasksSecurityError("每日任务路径不存在");
    }
    if (stat.isSymbolicLink()) {
      throw new DailyTasksSecurityError("每日任务目录或文件不能是软链接");
    }
  }
}

async function atomicWrite(filePath, contents, root) {
  const parent = path.dirname(filePath);
  await assertNoSymlinks(root, parent);
  const existing = await lstatOrNull(filePath);
  if (existing?.isSymbolicLink()) {
    throw new DailyTasksSecurityError("每日任务文件不能是软链接");
  }
  const tempPath = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(tempPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertNoSymlinks(root, parent);
    const current = await lstatOrNull(filePath);
    if (current?.isSymbolicLink()) {
      throw new DailyTasksSecurityError("每日任务文件不能是软链接");
    }
    await fs.rename(tempPath, filePath);
    const directoryHandle = await fs.open(parent, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(tempPath).catch(() => {});
  }
}

export function createDailyTasksStore(options = {}) {
  const root = path.resolve(options.root ?? process.env.V2_VAULT_ROOT ?? process.env.OBSIDIAN_VAULT_ROOT ?? path.join(os.homedir(), "第二大脑-v2"));
  const stateRoot = path.resolve(options.stateRoot ?? process.env.COCKPIT_STATE_ROOT ?? path.join(os.homedir(), ".media-growth-cockpit"));
  const backupRoot = path.join(stateRoot, "backups", "daily-tasks");
  const auditPath = path.join(stateRoot, "audit", "daily-tasks.jsonl");
  const now = options.now ?? (() => new Date());
  const afterWrite = options.afterWrite;
  const safeState = createSafeStatePaths({
    stateRoot,
    label: "每日任务状态",
    createSecurityError: (message) => new DailyTasksSecurityError(message),
  });

  function resolveRuntimeSettings() {
    const settings = readCockpitSettingsSync(root);
    return {
      ownerName: options.ownerName ?? settings.ownerName,
      dailyTasksRelativeDir: path.join(options.projectRelativeDir ?? settings.projectRelativeDir, "07-每日任务"),
    };
  }

  function filePathForDate(date, runtime = resolveRuntimeSettings()) {
    validateDate(date);
    const target = path.resolve(root, runtime.dailyTasksRelativeDir, `${date}-今日三件事.md`);
    assertInsideRoot(path.resolve(root, runtime.dailyTasksRelativeDir), target);
    return target;
  }

  async function audit(event) {
    const safeEvent = {
      at: now().toISOString(),
      action: event.action,
      date: event.date,
      status: event.status,
      count: event.count,
      hash: event.hash ? event.hash.slice(0, 12) : null,
    };
    await safeState.appendFile(auditPath, `${JSON.stringify(safeEvent)}\n`);
  }

  async function readFrom(date, filePath) {
    validateDate(date);
    const parent = path.dirname(filePath);
    const parentStat = await lstatOrNull(parent);
    if (!parentStat) {
      return { date, tasks: [], hash: null, updatedAt: null, notFound: true };
    }
    await assertNoSymlinks(root, parent);
    const fileStat = await lstatOrNull(filePath);
    if (!fileStat) {
      return { date, tasks: [], hash: null, updatedAt: null, notFound: true };
    }
    if (fileStat.isSymbolicLink()) {
      throw new DailyTasksSecurityError("每日任务文件不能是软链接");
    }
    if (!fileStat.isFile()) {
      throw new DailyTasksSecurityError("每日任务目标不是普通文件");
    }
    if (fileStat.size > 64 * 1024) {
      throw new DailyTasksSecurityError("每日任务文件超过 64KB 安全上限");
    }
    const contents = await fs.readFile(filePath, "utf8");
    if (hasSecret(contents)) throw new DailyTasksSecurityError("每日任务包含疑似密钥或凭证，已停止同步");
    const parsed = parseDailyTasksMarkdown(contents);
    if (parsed.frontmatter.type !== "任务日志") {
      throw new DailyTasksValidationError("每日任务文件 type 必须是任务日志");
    }
    if (parsed.frontmatter.date !== date) {
      throw new DailyTasksValidationError("每日任务文件日期与文件名不一致");
    }
    if (parsed.frontmatter.confirmation !== "已确认") {
      throw new DailyTasksValidationError("每日任务文件必须经过确认");
    }
    if (parsed.frontmatter.sensitivity === "敏感") {
      throw new DailyTasksSecurityError("敏感任务不会同步到驾驶舱");
    }
    return {
      date,
      tasks: parsed.tasks.map(toPublicTask),
      hash: sha256(contents),
      updatedAt: fileStat.mtime.toISOString(),
      notFound: false,
    };
  }

  async function read(date) {
    const runtime = resolveRuntimeSettings();
    return readFrom(date, filePathForDate(date, runtime));
  }

  async function writeUnlocked(date, tasks, expectedHash, runtime, filePath) {
    validateDate(date);
    const validated = dailyTasksInputSchema.safeParse(tasks);
    if (!validated.success) {
      throw new DailyTasksValidationError("今日任务数据无效", validated.error);
    }
    if (expectedHash !== null && (typeof expectedHash !== "string" || !HASH_RE.test(expectedHash))) {
      throw new DailyTasksValidationError("expectedHash 必须是 64 位小写 SHA-256 或 null");
    }
    await safeState.prepareAppendFile(auditPath);
    const parent = path.dirname(filePath);
    await assertNoSymlinks(root, parent, { allowMissing: true });
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    await assertNoSymlinks(root, parent);

    const current = await readFrom(date, filePath);
    if (current.hash !== expectedHash) {
      await audit({ action: "write", date, status: "conflict", count: validated.data.length, hash: current.hash });
      throw new DailyTasksConflictError(current);
    }

    let previousContents = null;
    let previousFrontmatter = {};
    let previousBody = null;
    if (!current.notFound) {
      previousContents = await fs.readFile(filePath, "utf8");
      if (sha256(previousContents) !== current.hash) {
        throw new DailyTasksConflictError(await readFrom(date, filePath));
      }
      const parsedPrevious = parseDailyTasksMarkdown(previousContents);
      previousFrontmatter = parsedPrevious.frontmatter;
      previousBody = parsedPrevious.body;
      const stamp = now().toISOString().replace(/[^0-9]/g, "").slice(0, 17);
      const backupPath = path.join(backupRoot, `${date}-${stamp}-${current.hash.slice(0, 12)}-${crypto.randomUUID().slice(0, 8)}.md`);
      await safeState.writeNewFile(backupPath, previousContents);
    }

    const contents = serializeDailyTasksMarkdown({ date, frontmatter: previousFrontmatter, body: previousBody, tasks: validated.data, ownerName: runtime.ownerName });
    const latest = await readFrom(date, filePath);
    if (latest.hash !== current.hash) {
      throw new DailyTasksConflictError(latest);
    }
    await atomicWrite(filePath, contents, root);
    const writtenHash = sha256(contents);

    try {
      if (afterWrite) await afterWrite({ root, date, filePath });
    } catch (error) {
      let rollbackError;
      try {
        const beforeRollback = await readFrom(date, filePath);
        if (beforeRollback.hash !== writtenHash) {
          throw new DailyTasksConflictError(beforeRollback);
        }
        if (previousContents === null) {
          throw new DailyTasksCommitError("新任务文件已保留，避免在失败恢复中误删路径");
        } else {
          await atomicWrite(filePath, previousContents, root);
        }
        if (afterWrite) await afterWrite({ root, date, filePath, rollback: true });
      } catch (caught) {
        rollbackError = caught;
      }
      await audit({ action: "write", date, status: rollbackError ? "rollback-failed" : "rolled-back", count: validated.data.length, hash: current.hash });
      throw new DailyTasksCommitError(
        rollbackError
          ? "索引校验失败，且自动恢复未能完整完成"
          : "索引校验失败，任务文件已恢复到修改前版本",
        { cause: error, rollbackError },
      );
    }

    const saved = await readFrom(date, filePath);
    await audit({ action: "write", date, status: "success", count: validated.data.length, hash: saved.hash });
    return saved;
  }

  function write(date, tasks, expectedHash) {
    let runtime;
    let filePath;
    try {
      runtime = resolveRuntimeSettings();
      filePath = filePathForDate(date, runtime);
    } catch (error) {
      return Promise.reject(error);
    }
    return runWithSharedWriteQueue(
      filePath,
      () => writeUnlocked(date, tasks, expectedHash, runtime, filePath),
    );
  }

  return { root, stateRoot, filePathForDate, read, write };
}
