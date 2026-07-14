import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { parse as parseYaml } from "yaml";
import {
  AiResultImportCommitError,
  AiResultImportDuplicateError,
  AiResultImportSecurityError,
  AiResultImportValidationError,
  createAiResultImporter,
} from "../ai-collaboration/obsidian-result-importer.mjs";
import {
  DEFAULT_COCKPIT_SETTINGS,
  createCockpitSettingsStore,
} from "../cockpit-settings-store.mjs";

const temporaryDirectories = [];
const NOW = new Date("2026-07-14T08:30:00.000Z");
const RUN_ID = "run-11111111-1111-4111-8111-111111111111";
const PROJECT_RELATIVE_DIR = "50-进行中项目/AI博主增长计划";

async function project() {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const base = await fs.mkdtemp(path.join(temporaryRoot, "creator-ai-import-"));
  temporaryDirectories.push(base);
  const root = path.join(base, "vault");
  const stateRoot = path.join(base, "state");
  await fs.mkdir(root);
  const settingsStore = createCockpitSettingsStore({
    root,
    stateRoot,
    now: () => NOW,
    afterWrite: async () => {},
  });
  await settingsStore.write({
    ...DEFAULT_COCKPIT_SETTINGS,
    projectRelativeDir: PROJECT_RELATIVE_DIR,
  }, null);
  return { base, root, stateRoot };
}

function completedRun(overrides = {}) {
  return {
    runId: RUN_ID,
    provider: "codex",
    templateId: "analyze-topic",
    context: {
      type: "topic",
      id: "topic-001",
      title: "AI 工具如何进入真实工作流",
      summary: "用户在页面中选择的选题摘要。",
    },
    finalText: "## 结论\n\n先从一个每天都会发生的任务开始验证。",
    imports: [],
    status: "completed",
    ...overrides,
  };
}

function importerFor(value, options = {}) {
  return createAiResultImporter({
    root: value.root,
    stateRoot: value.stateRoot,
    now: () => NOW,
    afterWrite: async () => {},
    ...options,
  });
}

function splitFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
  assert.ok(match, "应生成完整 frontmatter");
  return { frontmatter: parseYaml(match[1]), body: match[2] };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("AI 协作结果安全导入 Obsidian", () => {
  test("正常导入：只在项目工作过程写一份已确认 Markdown，并记录外部审计", async () => {
    const value = await project();
    const afterWriteCalls = [];
    const importer = importerFor(value, {
      afterWrite: async (context) => afterWriteCalls.push(context),
    });

    const result = await importer.importRun(completedRun());

    assert.equal(
      result.relativePath,
      `${PROJECT_RELATIVE_DIR}/03-工作过程/AI协作/${RUN_ID}-AI协作结果.md`,
    );
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.confirmedAt, NOW.toISOString());
    assert.equal(afterWriteCalls.length, 1);
    assert.equal(afterWriteCalls[0].root, value.root);
    assert.equal(afterWriteCalls[0].runId, RUN_ID);
    assert.equal(afterWriteCalls[0].rollback, undefined);

    const markdown = await fs.readFile(path.join(value.root, ...result.relativePath.split("/")), "utf8");
    const { frontmatter, body } = splitFrontmatter(markdown);
    assert.equal(frontmatter.type, "AI协作结果");
    assert.equal(frontmatter.status, "已完成");
    assert.equal(frontmatter.source_run, RUN_ID);
    assert.equal(frontmatter.provider, "codex");
    assert.equal(frontmatter.template, "analyze-topic");
    assert.deepEqual(frontmatter.context, {
      type: "topic",
      id: "topic-001",
      title: "AI 工具如何进入真实工作流",
      summary: "用户在页面中选择的选题摘要。",
    });
    assert.equal(frontmatter.confirmation, "已确认");
    assert.equal(frontmatter.sensitivity, "内部");
    assert.equal(frontmatter.confirmed_at, NOW.toISOString());
    assert.equal(body, "# AI 工具如何进入真实工作流\n\n## 结论\n\n先从一个每天都会发生的任务开始验证。\n");
    assert.doesNotMatch(body, /来源|工作过程|根据你的要求|作为 AI/);

    const audit = (await fs.readFile(importer.auditPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0], {
      at: NOW.toISOString(),
      action: "import-ai-result",
      runId: RUN_ID,
      provider: "codex",
      templateId: "analyze-topic",
      status: "success",
      relativePath: result.relativePath,
      sha256: result.sha256,
    });
    assert.deepEqual(await fs.readdir(importer.backupRoot), []);
  });

  test("重复导入：共享写队列保证并发请求只成功一次，manifest 已有 imports 也拒绝", async () => {
    const value = await project();
    const importer = importerFor(value);
    const settled = await Promise.allSettled([
      importer.importRun(completedRun()),
      importer.importRun(completedRun()),
    ]);
    assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
    const rejected = settled.find((item) => item.status === "rejected");
    assert.ok(rejected.reason instanceof AiResultImportDuplicateError);

    await assert.rejects(importer.importRun(completedRun({
      runId: "run-22222222-2222-4222-8222-222222222222",
      imports: [{ relativePath: "already-imported.md" }],
    })), AiResultImportDuplicateError);
  });

  test("幂等恢复：服务记录失败后可按固定 runId 返回字节完全一致的已有结果", async () => {
    const value = await project();
    const first = await importerFor(value).importRun(completedRun());
    const later = new Date("2026-07-14T09:45:00.000Z");
    const afterWriteCalls = [];
    const retryImporter = importerFor(value, {
      now: () => later,
      afterWrite: async (context) => afterWriteCalls.push(context),
    });

    const recovered = await retryImporter.importRun(completedRun(), { recoverExisting: true });

    assert.deepEqual(recovered, { ...first, recovered: true });
    assert.equal(recovered.confirmedAt, NOW.toISOString());
    assert.equal(afterWriteCalls.length, 1);
    assert.equal(afterWriteCalls[0].recovered, true);
    const audit = (await fs.readFile(retryImporter.auditPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(audit.length, 2);
    assert.deepEqual(audit.map((item) => item.status), ["success", "recovered"]);
  });

  test("幂等恢复：索引刷新失败时保留结果并允许再次重试", async () => {
    const value = await project();
    const first = await importerFor(value).importRun(completedRun());
    let shouldFail = true;
    const retryImporter = importerFor(value, {
      afterWrite: async () => {
        if (shouldFail) throw new Error("模拟恢复时索引刷新失败");
      },
    });
    const filePath = path.join(value.root, ...first.relativePath.split("/"));
    const original = await fs.readFile(filePath, "utf8");

    await assert.rejects(
      retryImporter.importRun(completedRun(), { recoverExisting: true }),
      (error) => {
        assert.ok(error instanceof AiResultImportCommitError);
        assert.match(error.message, /可安全重试/);
        return true;
      },
    );
    assert.equal(await fs.readFile(filePath, "utf8"), original);

    shouldFail = false;
    const recovered = await retryImporter.importRun(completedRun(), { recoverExisting: true });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.sha256, first.sha256);
  });

  test("幂等恢复：同一 runId 内容变化时仍拒绝，且不覆盖已有文件", async () => {
    const value = await project();
    const importer = importerFor(value);
    const first = await importer.importRun(completedRun());
    const filePath = path.join(value.root, ...first.relativePath.split("/"));
    const original = await fs.readFile(filePath, "utf8");

    await assert.rejects(
      importer.importRun(completedRun({ finalText: "## 不同结论\n\n不得覆盖原结果。" }), { recoverExisting: true }),
      (error) => {
        assert.ok(error instanceof AiResultImportDuplicateError);
        assert.match(error.message, /不一致.*拒绝覆盖/);
        return true;
      },
    );
    assert.equal(await fs.readFile(filePath, "utf8"), original);
  });

  test("幂等恢复：目标文件或路径存在软链时拒绝恢复", async () => {
    const value = await project();
    const importer = importerFor(value);
    const first = await importer.importRun(completedRun());
    const filePath = path.join(value.root, ...first.relativePath.split("/"));
    const outside = path.join(value.base, "outside-result.md");
    await fs.copyFile(filePath, outside);
    await fs.unlink(filePath);
    await fs.symlink(outside, filePath, "file");

    await assert.rejects(
      importer.importRun(completedRun(), { recoverExisting: true }),
      AiResultImportSecurityError,
    );
  });

  test("状态与数据契约：拒绝非 completed、危险 runId、空结果和非绝对根目录", async () => {
    const value = await project();
    const importer = importerFor(value);
    await assert.rejects(importer.importRun(completedRun({ status: "running" })), AiResultImportValidationError);
    await assert.rejects(importer.importRun(completedRun({ runId: "../escape" })), AiResultImportValidationError);
    await assert.rejects(importer.importRun(completedRun({ finalText: "  " })), AiResultImportValidationError);
    assert.throws(() => createAiResultImporter({ root: "relative", stateRoot: value.stateRoot }), AiResultImportValidationError);
    assert.throws(() => createAiResultImporter({
      root: `${value.root}/../vault`,
      stateRoot: value.stateRoot,
    }), AiResultImportSecurityError);
  });

  test("内容边界：拒绝 NUL/控制字符、可执行 HTML、疑似凭证和超过 2MiB 的文件", async () => {
    const value = await project();
    const importer = importerFor(value);
    await assert.rejects(importer.importRun(completedRun({ finalText: "正文\0隐藏" })), AiResultImportSecurityError);
    await assert.rejects(importer.importRun(completedRun({ finalText: "<script>alert('x')</script>" })), AiResultImportSecurityError);
    await assert.rejects(importer.importRun(completedRun({ finalText: "<img src=x onerror=alert(1)>" })), AiResultImportSecurityError);
    await assert.rejects(importer.importRun(completedRun({ finalText: "Authorization: Bearer secret-token-value" })), AiResultImportSecurityError);
    await assert.rejects(importer.importRun(completedRun({ finalText: "-----BEGIN PRIVATE KEY-----\nsecret\n" })), AiResultImportSecurityError);
    await assert.rejects(
      importer.importRun(completedRun({ finalText: "中".repeat(800_000) })),
      AiResultImportValidationError,
    );
  });

  test("路径与软链：导入目录软链不能把结果写到 Vault 外部", async () => {
    const value = await project();
    const outside = path.join(value.base, "outside");
    const workRoot = path.join(value.root, ...PROJECT_RELATIVE_DIR.split("/"), "03-工作过程");
    await fs.mkdir(workRoot, { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "sentinel.txt"), "unchanged", "utf8");
    await fs.symlink(outside, path.join(workRoot, "AI协作"), "dir");

    await assert.rejects(importerFor(value).importRun(completedRun()), AiResultImportSecurityError);
    assert.equal(await fs.readFile(path.join(outside, "sentinel.txt"), "utf8"), "unchanged");
    assert.deepEqual(await fs.readdir(outside), ["sentinel.txt"]);
  });

  test("外部审计和备份目录同样拒绝软链，Vault 与外部文件均保持不变", async () => {
    const auditValue = await project();
    const outsideAudit = path.join(auditValue.base, "outside-audit.jsonl");
    await fs.writeFile(outsideAudit, "sentinel\n", "utf8");
    await fs.mkdir(path.join(auditValue.stateRoot, "audit"), { recursive: true });
    await fs.symlink(outsideAudit, path.join(auditValue.stateRoot, "audit", "ai-result-imports.jsonl"), "file");
    await assert.rejects(importerFor(auditValue).importRun(completedRun()), AiResultImportSecurityError);
    assert.equal(await fs.readFile(outsideAudit, "utf8"), "sentinel\n");
    assert.equal(await fs.stat(path.join(auditValue.root, ...PROJECT_RELATIVE_DIR.split("/"))).catch(() => null), null);

    const backupValue = await project();
    const outsideBackup = path.join(backupValue.base, "outside-backup");
    await fs.mkdir(outsideBackup);
    await fs.mkdir(path.join(backupValue.stateRoot, "backups"), { recursive: true });
    await fs.symlink(outsideBackup, path.join(backupValue.stateRoot, "backups", "ai-result-imports"), "dir");
    await assert.rejects(importerFor(backupValue).importRun(completedRun()), AiResultImportSecurityError);
    assert.deepEqual(await fs.readdir(outsideBackup), []);
    assert.equal(await fs.stat(path.join(backupValue.root, ...PROJECT_RELATIVE_DIR.split("/"))).catch(() => null), null);
  });

  test("索引失败：删除新文件，调用 rollback 复验并保留最小审计", async () => {
    const value = await project();
    const calls = [];
    const importer = importerFor(value, {
      afterWrite: async (context) => {
        calls.push(context);
        if (!context.rollback) throw new Error("模拟索引失败");
      },
    });

    await assert.rejects(importer.importRun(completedRun()), (error) => {
      assert.ok(error instanceof AiResultImportCommitError);
      assert.equal(error.rollbackError, undefined);
      assert.match(error.message, /已删除导入文件并复验/);
      return true;
    });

    assert.deepEqual(calls.map((call) => call.rollback ?? false), [false, true]);
    const importRoot = path.join(value.root, ...PROJECT_RELATIVE_DIR.split("/"), "03-工作过程", "AI协作");
    assert.deepEqual(await fs.readdir(importRoot), []);
    const audit = (await fs.readFile(importer.auditPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].status, "rolled_back");
    assert.doesNotMatch(JSON.stringify(audit), /每天都会发生的任务/);
  });
});
