import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import {
  parseFrontmatter,
} from "../lib/frontmatter.mjs";
import {
  isSafeRelativePath,
  readSafeMarkdown,
  hasSecret,
  containsDangerousUrl,
  toPlainText,
  MAX_FILE_BYTES,
  SecurityError,
} from "../lib/security.mjs";
import {
  buildVaultIndex,
  commitFilesAtomically,
  contentCompletedAt,
  dedupePublicationEvents,
  isCompletionInCampaign,
  isKnowledgeInCampaign,
  isPublicationInCampaign,
  linkTodayTasks,
  parseDailyTasksFromBody,
  parsePublicationRecords,
  reviewConfirmedAt,
  toPublicIndex,
} from "../build-vault-index.mjs";
import { todayTasksIndexSchema } from "../lib/index-validation-schemas.mjs";
import { indexSchema } from "../validate-data.mjs";

const REAL_ROOT = process.env.OBSIDIAN_VAULT_ROOT || path.join(os.homedir(), "第二大脑-v2");
const HAS_REAL_ROOT = fs.existsSync(REAL_ROOT);

function sha256(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

function makeFrontmatter(extra = {}) {
  return `---\n${Object.entries(extra).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n# Title\n\nbody text.\n`;
}

describe("路径安全", () => {
  it("拒绝绝对路径", () => {
    assert.equal(isSafeRelativePath("/etc/passwd"), false);
  });

  it("拒绝 NUL 字节", () => {
    assert.equal(isSafeRelativePath("file\0.md"), false);
  });

  it("拒绝 .. 穿越", () => {
    assert.equal(isSafeRelativePath("../secret.md"), false);
    assert.equal(isSafeRelativePath("foo/../../secret.md"), false);
  });

  it("接受安全相对路径", () => {
    assert.equal(isSafeRelativePath("foo/bar.md"), true);
  });
});

describe("每日任务解析", () => {
  it("保留稳定 id 与完成状态", () => {
    const tasks = parseDailyTasksFromBody(
      "# 今日三件事\n\n- [x] 已完成 <!-- task:daily-a -->\n- [ ] 待完成 <!-- task:daily-b -->\n",
      "2026-07-12",
    );
    assert.deepEqual(tasks.map(({ id, title, done }) => ({ id, title, done })), [
      { id: "daily-a", title: "已完成", done: true },
      { id: "daily-b", title: "待完成", done: false },
    ]);
  });

  it("拒绝超过三条和重复 id", () => {
    assert.throws(
      () => parseDailyTasksFromBody("- [ ] 一\n- [ ] 二\n- [ ] 三\n- [ ] 四\n", "2026-07-12"),
      /最多只能有 3 条/,
    );
    assert.throws(
      () => parseDailyTasksFromBody("- [ ] 一 <!-- task:same -->\n- [ ] 二 <!-- task:same -->\n", "2026-07-12"),
      /id 重复/,
    );
  });

  it("兼容 task-id 标记并拒绝超过 120 字或 HTML 标题", () => {
    const parsed = parseDailyTasksFromBody("- [ ] 合法任务 <!-- task-id:stable-id -->", "2026-07-13");
    assert.equal(parsed[0].id, "stable-id");
    assert.throws(() => parseDailyTasksFromBody(`- [ ] ${"长".repeat(121)}`, "2026-07-13"));
    assert.throws(() => parseDailyTasksFromBody("- [ ] <script>危险</script>", "2026-07-13"));
  });

  it("从 task_links 回读关系并拒绝路径或未知类型", () => {
    const body = "- [ ] 生成文章 <!-- task:daily-a -->\n- [ ] 复盘内容 <!-- task:daily-b -->\n";
    const parsed = parseDailyTasksFromBody(body, "2026-07-12", {
      "daily-a": { type: "topic", id: "topic-ai-workflow" },
      "daily-b": { type: "content-review", id: "review-ai-workflow" },
      orphan: { type: "task", id: "vault-task-orphan" },
    });
    assert.deepEqual(parsed.map(({ id, linkType, linkId }) => ({ id, linkType, linkId })), [
      { id: "daily-a", linkType: "topic", linkId: "topic-ai-workflow" },
      { id: "daily-b", linkType: "content-review", linkId: "review-ai-workflow" },
    ]);
    assert.throws(
      () => parseDailyTasksFromBody(body, "2026-07-12", {
        "daily-a": { type: "content", id: "content-1", path: "../../secret.md" },
      }),
      /只能包含 type 和 id/,
    );
    assert.throws(
      () => parseDailyTasksFromBody(body, "2026-07-12", {
        "daily-a": { type: "unknown", id: "content-1" },
      }),
      /type 不受支持/,
    );
  });

  it("显式 task_links 优先，同时保留旧项目日期任务的标题匹配", () => {
    const projectTask = { id: "vault-task-project-date", title: "确认项目正式开始日期", status: "待办" };
    const [explicit] = linkTodayTasks([{
      id: "daily-a",
      title: "确认项目正式开始日期",
      done: false,
      linkType: "daily-review",
      linkId: "daily-review-1",
    }], [projectTask]);
    assert.equal(explicit.linkType, "daily-review");
    assert.equal(explicit.linkId, "daily-review-1");

    const [legacy] = linkTodayTasks([{
      id: "daily-b",
      title: "确认项目正式开始日期",
      done: false,
      linkType: null,
      linkId: null,
    }], [projectTask]);
    assert.equal(legacy.linkType, "task");
    assert.equal(legacy.linkId, projectTask.id);
  });
});

describe("每日任务索引契约", () => {
  const task = (id) => ({ id, title: `任务 ${id}`, done: false, linkId: null, linkType: null });

  it("允许 0 到 3 条任务", () => {
    assert.equal(todayTasksIndexSchema.safeParse([]).success, true);
    assert.equal(todayTasksIndexSchema.safeParse([task("1")]).success, true);
    assert.equal(todayTasksIndexSchema.safeParse([task("1"), task("2"), task("3")]).success, true);
  });

  it("拒绝第 4 条任务", () => {
    assert.equal(todayTasksIndexSchema.safeParse([task("1"), task("2"), task("3"), task("4")]).success, false);
  });

  it("只接受六种成对的任务关系", () => {
    for (const linkType of ["topic", "content", "content-review", "account-breakdown", "daily-review", "task"]) {
      assert.equal(todayTasksIndexSchema.safeParse([{
        ...task("linked"),
        linkId: "asset-one",
        linkType,
      }]).success, true);
    }
    assert.equal(todayTasksIndexSchema.safeParse([{
      ...task("half"),
      linkId: "asset-one",
      linkType: null,
    }]).success, false);
    assert.equal(todayTasksIndexSchema.safeParse([{
      ...task("unknown"),
      linkId: "asset-one",
      linkType: "file-path",
    }]).success, false);
    assert.equal(todayTasksIndexSchema.safeParse([{
      ...task("linked"),
      linkId: "vault-task-含中文的旧ID-3",
      linkType: "task",
    }]).success, false);
  });
});

describe("完整索引动态契约", { skip: !HAS_REAL_ROOT }, () => {
  it("允许数据日期推进和资产集合增长", () => {
    const { index } = buildVaultIndex(fs.realpathSync(REAL_ROOT));
    const candidate = structuredClone(index);
    candidate.growth.summary.asOf = "2026-07-13";
    candidate.knowledge.push({ ...candidate.knowledge[0], id: "knowledge-extra" });
    candidate.projectDocuments.push({ ...candidate.projectDocuments[0], id: "project-extra" });
    candidate.tasks.push({ ...candidate.tasks[0], id: "task-extra" });
    candidate.experiments.push({
      id: "experiment-extra",
      title: "标题实验",
      hypothesis: "标题更具体会提高点击",
      variable: "标题",
      baseline: "基线待记录",
      target: "点击率提升",
      result: "证据不足",
      decision: "继续观察",
      relatedContent: [],
      nextAction: "补充样本",
      updatedAt: "2026-07-13",
    });
    candidate.reviewItems.push({ ...candidate.reviewItems[0], id: "review-extra" });
    candidate.meta.reviewItems = candidate.reviewItems.length;

    assert.equal(indexSchema.safeParse(candidate).success, true);
  });

  it("Public 索引只保留不透明引用，不下发 V2 路径", () => {
    const { index } = buildVaultIndex(fs.realpathSync(REAL_ROOT));
    const publicIndex = toPublicIndex(index);
    assert.equal(publicIndex.sourceFiles.length, 0);
    assert.equal(publicIndex.meta.parsedFiles, 0);
    const raw = JSON.stringify(publicIndex);
    assert.doesNotMatch(raw, /(?:10-原始材料|20-知识资产|30-内容资产|50-进行中项目|00-收件箱)\//);
    assert.ok(publicIndex.contents.every((item) => item.source.startsWith("content:")));
    assert.ok(publicIndex.evidence.every((item) => item.sourceEvidence.startsWith("evidence:")));
  });
});

describe("文件读取安全", () => {
  let tmpDir;
  let rootReal;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-indexer-"));
    rootReal = fs.realpathSync(tmpDir);
    fs.mkdirSync(path.join(rootReal, "dir"));
    fs.writeFileSync(path.join(rootReal, "dir", "safe.md"), "---\nid: x\n---\n\nbody\n");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("拒绝软链接文件", () => {
    fs.writeFileSync(path.join(rootReal, "target.md"), "content");
    fs.symlinkSync(path.join(rootReal, "target.md"), path.join(rootReal, "link.md"));
    assert.throws(() => readSafeMarkdown(rootReal, "link.md"), SecurityError);
  });

  it("拒绝通过软链接目录读取", () => {
    fs.symlinkSync(path.join(rootReal, "dir"), path.join(rootReal, "linkdir"), "dir");
    assert.throws(() => readSafeMarkdown(rootReal, "linkdir/safe.md"), SecurityError);
  });

  it("拒绝超过 1 MiB 的文件", () => {
    const big = path.join(rootReal, "big.md");
    const content = "x".repeat(MAX_FILE_BYTES + 1);
    fs.writeFileSync(big, content);
    assert.throws(() => readSafeMarkdown(rootReal, "big.md"), SecurityError);
  });

  it("拒绝非普通文件（FIFO）", { skip: process.platform === "win32" }, () => {
    const fifo = path.join(rootReal, "fifo.md");
    execSync(`mkfifo ${fifo}`);
    assert.throws(() => readSafeMarkdown(rootReal, "fifo.md"), SecurityError);
  });

  it("拒绝跳出根目录", () => {
    assert.throws(() => readSafeMarkdown(rootReal, "../escape.md"), SecurityError);
  });
});

describe("Frontmatter 安全", () => {
  it("解析正常 Frontmatter", () => {
    const raw = "---\nid: abc\ntopics: [a, b]\n---\n\n# Title\n";
    const { data } = parseFrontmatter(raw);
    assert.equal(data.id, "abc");
    assert.deepEqual(data.topics, ["a", "b"]);
  });

  it("拒绝坏 YAML", () => {
    const raw = "---\nid: [unclosed\n---\n";
    assert.throws(() => parseFrontmatter(raw));
  });

  it("拒绝重复键", () => {
    const raw = "---\nid: a\nid: b\n---\n";
    assert.throws(() => parseFrontmatter(raw));
  });

  it("拒绝自定义 tag", () => {
    const raw = "---\n!secret key: value\n---\n";
    assert.throws(() => parseFrontmatter(raw));
  });

  it("拒绝 alias bomb", () => {
    const aliases = Array.from({ length: 120 }, (_, index) => `k${index}: *a`).join("\n");
    const raw = `---\na: &a [1, 2, 3]\n${aliases}\n---\n`;
    assert.throws(() => parseFrontmatter(raw));
  });
});

describe("敏感信息过滤", () => {
  it("检测 Token", () => {
    assert.equal(hasSecret("api_token: sk-abc123xyz"), true);
  });

  it("检测 Cookie", () => {
    assert.equal(hasSecret("cookie: session=abcdef"), true);
  });

  it("检测 Bearer", () => {
    assert.equal(hasSecret("Authorization: Bearer abcdef12345"), true);
  });

  it("检测 GitHub token", () => {
    assert.equal(hasSecret("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), true);
  });

  it("检测常见云端密钥和私钥", () => {
    assert.equal(hasSecret("sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456"), true);
    assert.equal(hasSecret(`AIza${"A".repeat(35)}`), true);
    assert.equal(hasSecret("AKIAIOSFODNN7EXAMPLE"), true);
    assert.equal(
      hasSecret("-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----"),
      true,
    );
  });

  it("普通文本不误报", () => {
    assert.equal(hasSecret("这是一条普通内容"), false);
  });
});

describe("纯文本摘要", () => {
  it("移除 HTML script 标签", () => {
    const text = toPlainText("# Title\n\n<script>alert(1)</script>Hello world.");
    assert.equal(text.includes("<script"), false);
    assert.equal(text.includes("alert(1)"), false);
  });

  it("移除图片与链接标记", () => {
    const text = toPlainText("[链接文字](https://example.com) 和 ![图片](a.png)");
    assert.equal(text, "链接文字 和 图片");
  });
});

describe("危险 URL 与原子提交", () => {
  it("检测嵌入 JSON 或文本中的危险协议", () => {
    assert.equal(containsDangerousUrl('{"url":"javascript:alert(1)"}'), true);
    assert.equal(containsDangerousUrl("链接 data:text/html,<script>"), true);
    assert.equal(containsDangerousUrl("https://example.com"), false);
  });

  it("多文件提交中途失败时恢复全部上一版", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-index-"));
    const canonical = path.join(dir, "index.json");
    const publicCopy = path.join(dir, "public.json");
    fs.writeFileSync(canonical, "old-canonical");
    fs.writeFileSync(publicCopy, "old-public");

    assert.throws(() => commitFilesAtomically([
      { path: canonical, content: "new", mode: 0o600 },
      { path: publicCopy, content: "new", mode: 0o644 },
    ], {
      beforeRename: (_state, index) => {
        if (index === 1) throw new Error("simulated public commit failure");
      },
    }));

    assert.equal(fs.readFileSync(canonical, "utf8"), "old-canonical");
    assert.equal(fs.readFileSync(publicCopy, "utf8"), "old-public");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("发布证据与项目期计数", () => {
  it("只有完整发布时间、证据和已核验标记的记录才成立", () => {
    const [verified, unverified, impossibleDate] = parsePublicationRecords([
      {
        platform: "公众号",
        published_at: "2026-07-12T05:00:00.000Z",
        evidence_ref: "[[2026-07-12-公众号发布证据]]",
        verification: "已核验",
      },
      {
        platform: "抖音",
        published_at: null,
        observed: "已发布",
      },
      {
        platform: "小红书",
        published_at: "2026-02-31T12:00:00+08:00",
        evidence_ref: "[[错误日期证据]]",
        verification: "已核验",
      },
    ]);
    assert.equal(verified.verified, true);
    assert.equal(unverified.verified, false);
    assert.equal(unverified.hasObservation, true);
    assert.equal(impossibleDate.verified, false);
    assert.equal(isPublicationInCampaign(verified, "2026-07-12T04:00:00.000Z"), true);
    assert.equal(isPublicationInCampaign(verified, "2026-07-12T06:00:00.000Z"), false);
  });

  it("制作完成与发布是两个独立事实，发布可兜底推导完成时间", () => {
    const records = parsePublicationRecords([{
      platform: "公众号",
      published_at: "2026-07-13T05:00:00.000Z",
      url: "https://example.com/article-1",
      verification: "已核验",
    }]);
    assert.equal(
      contentCompletedAt({ completed_at: "2026-07-13T04:00:00.000Z" }, records, "article.md"),
      "2026-07-13T04:00:00.000Z",
    );
    assert.equal(contentCompletedAt({}, records, "legacy.md"), "2026-07-13T05:00:00.000Z");
    assert.equal(contentCompletedAt({}, [], "draft.md"), null);
    assert.equal(
      isCompletionInCampaign({ completedAt: "2026-07-13T04:00:00.000Z" }, "2026-07-13T03:00:00.000Z"),
      true,
    );
    assert.equal(
      isCompletionInCampaign({ completedAt: "2026-07-13T02:00:00.000Z" }, "2026-07-13T03:00:00.000Z"),
      false,
    );
    assert.throws(
      () => contentCompletedAt({ completed_at: "2026-07-13" }, records, "broken.md"),
      /completed_at 必须是完整 ISO 时间/,
    );
  });

  it("同一发布事实不会因重复记录被重复计数", () => {
    const records = [
      { platform: "公众号", publishedAt: "2026-07-13T05:00:00.000Z", url: "https://example.com/post", evidenceRef: null },
      { platform: "小红书", publishedAt: "2026-07-13T06:00:00.000Z", url: "https://example.com/post", evidenceRef: null },
      { platform: "抖音", publishedAt: "2026-07-13T07:00:00.000Z", url: null, evidenceRef: "10-原始材料/证据.png" },
      { platform: "抖音", publishedAt: "2026-07-13T07:00:00.000Z", url: null, evidenceRef: "10-原始材料/证据.png" },
    ];
    assert.equal(dedupePublicationEvents(records).length, 2);
  });
});

describe("复盘确认时间与项目期计数", () => {
  it("只按完整 confirmed_at 计数，启动当天确认有效，旧文件缺失时不猜测", () => {
    const campaignStartedAt = "2026-07-13T03:00:00.000Z";
    const confirmedAt = reviewConfirmedAt(
      { created_at: "2026-07-12", confirmed_at: "2026-07-13T04:05:06.789Z" },
      "review.md",
    );
    assert.equal(confirmedAt, "2026-07-13T04:05:06.789Z");
    assert.equal(isKnowledgeInCampaign({ occurredAt: confirmedAt }, campaignStartedAt), true);
    assert.equal(reviewConfirmedAt({ created_at: "2026-07-12" }, "legacy.md"), null);
    assert.equal(isKnowledgeInCampaign({ occurredAt: null }, campaignStartedAt), false);
  });

  it("拒绝模糊或损坏的 confirmed_at", () => {
    assert.throws(
      () => reviewConfirmedAt({ confirmed_at: "2026-07-13" }, "broken.md"),
      /confirmed_at 必须是完整 ISO 时间/,
    );
    assert.throws(
      () => reviewConfirmedAt({ confirmed_at: "2026-02-31T04:05:06.789Z" }, "broken-date.md"),
      /confirmed_at 必须是完整 ISO 时间/,
    );
  });
});

describe("V2 真实索引", { skip: !HAS_REAL_ROOT }, () => {
  let beforeManifest;

  before(() => {
    // 记录真实 V2 所有 .md 文件 hash
    const files = [];
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          files.push(full);
        }
      }
    }
    walk(REAL_ROOT);
    beforeManifest = new Map(files.map((f) => [f, sha256(fs.readFileSync(f, "utf8"))]));
  });

  it("生成结构完整且计算口径一致的索引", () => {
    const rootReal = fs.realpathSync(REAL_ROOT);
    const { index, warnings } = buildVaultIndex(rootReal);

    assert.equal(warnings.length, 0);
    assert.ok(index.meta.parsedFiles > 0);
    assert.equal(index.meta.parsedFiles, index.meta.normalAssets + index.meta.reviewItems);

    assert.equal(index.growth.accounts.length, 6);
    const total = index.growth.accounts.reduce((s, a) => s + a.currentFollowers, 0);
    const summary = index.growth.summary;
    assert.equal(summary.currentFollowers, total);
    assert.equal(summary.gainedFollowers, total - summary.baselineFollowers);
    assert.equal(summary.growthTarget, 50000);
    assert.equal(summary.growthGap, Math.max(0, summary.growthTarget - summary.gainedFollowers));
    assert.equal(summary.expectedFollowers, summary.baselineFollowers + summary.growthTarget);
    assert.equal(summary.completionRate, Math.max(0, summary.gainedFollowers) / summary.growthTarget);

    assert.deepEqual(index.actionTargets.map(({ id }) => id), [
      "article-output",
      "video-output",
      "platform-publish",
      "content-review",
      "account-breakdown",
    ]);
    assert.ok(index.actionTargets.every((item) => Number.isInteger(item.current) && item.current >= 0));
    assert.ok(index.actionTargets.every((item) => Number.isInteger(item.target) && item.target > 0));

    assert.equal(new Set(index.contents.map((item) => item.id)).size, index.contents.length);
    assert.ok(index.contents.every((item) => !["调研中", "创作中", "制作中"].includes(item.status)));
    assert.match(summary.campaignStartedAt, /^\d{4}-\d{2}-\d{2}T/);

    assert.ok(index.todayTasks.length <= 3);
    assert.equal(new Set(index.todayTasks.map((item) => item.id)).size, index.todayTasks.length);
    assert.ok(index.todayTasks.every((item) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(item.id)));
    assert.ok(index.todayTasks.every((item) => item.linkId === null || /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(item.linkId)));
    assert.ok(index.evidence.every((item) => !/\.(?:jpe?g|png|webp)\b/i.test(item.sourceEvidence)));
    assert.equal(index.reviewItems.length, index.meta.reviewItems);

    for (const account of index.growth.accounts) {
      assert.equal(account.targetFollowers, null);
      assert.equal(account.gap, null);
    }
  });

  it("不修改 V2 文件", () => {
    for (const [file, beforeHash] of beforeManifest) {
      const afterHash = sha256(fs.readFileSync(file, "utf8"));
      assert.equal(afterHash, beforeHash, `${file} 在索引过程中被修改`);
    }
  });
});
