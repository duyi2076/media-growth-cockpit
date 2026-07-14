import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { afterEach, describe, test } from "node:test";
import {
  AI_RUN_METADATA_DATABASE_NAME,
  AI_RUN_METADATA_SCHEMA_VERSION,
  AI_RUN_PROVIDERS,
  AI_RUN_STATUSES,
  AI_RUN_TEMPLATE_IDS,
  AiRunMetadataSecurityError,
  AiRunMetadataStateError,
  AiRunMetadataValidationError,
  AiRunPermissionResolvedError,
  createAiRunMetadataDb,
} from "../ai-collaboration/run-metadata-db.mjs";

const temporaryDirectories = [];
const openStores = [];
const moduleUrl = new URL("../ai-collaboration/run-metadata-db.mjs", import.meta.url).href;
let runCounter = 1;

afterEach(async () => {
  for (const store of openStores.splice(0)) store.close();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function runId(number = runCounter++) {
  return `run-00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

async function makeRoot() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cockpit-ai-metadata-"));
  temporaryDirectories.push(parent);
  return { parent, stateRoot: path.join(parent, "state") };
}

function track(store) {
  openStores.push(store);
  return store;
}

function createRun(store, parent, overrides = {}) {
  return store.createRun({
    runId: overrides.runId ?? runId(),
    provider: overrides.provider ?? "codex",
    templateId: overrides.templateId ?? "analyze-topic",
    permissionMode: overrides.permissionMode ?? "readonly",
    workspacePath: overrides.workspacePath ?? path.join(parent, "workspace", overrides.runId ?? "run"),
    title: overrides.title ?? "测试运行",
    metadata: overrides.metadata ?? { sourceType: "topic", sourceId: "topic-1" },
  });
}

function workerResult(worker) {
  return new Promise((resolve, reject) => {
    let settled = false;
    worker.once("message", (message) => {
      settled = true;
      if (message?.ok) resolve(message);
      else reject(new Error(message?.error ?? "worker failed"));
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (!settled && code !== 0) reject(new Error(`worker exited with ${code}`));
    });
  });
}

describe("AI 运行 SQLite 元数据层", () => {
  test("首次打开完成 user_version 迁移、WAL 与权限收紧", async () => {
    const { stateRoot } = await makeRoot();
    const store = track(createAiRunMetadataDb({ stateRoot }));
    assert.equal(path.basename(store.dbPath), AI_RUN_METADATA_DATABASE_NAME);

    const rootMode = (await fs.stat(stateRoot)).mode & 0o777;
    const dbMode = (await fs.stat(store.dbPath)).mode & 0o777;
    assert.equal(rootMode, 0o700);
    assert.equal(dbMode, 0o600);

    const inspector = new Database(store.dbPath, { readonly: true, fileMustExist: true });
    try {
      assert.equal(inspector.pragma("user_version", { simple: true }), AI_RUN_METADATA_SCHEMA_VERSION);
      assert.equal(String(inspector.pragma("journal_mode", { simple: true })).toLowerCase(), "wal");
      const tables = inspector.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('runs', 'events', 'permissions', 'imports')
        ORDER BY name
      `).all().map((row) => row.name);
      assert.deepEqual(tables, ["events", "imports", "permissions", "runs"]);
    } finally {
      inspector.close();
    }
  });

  test("provider、模板和运行状态使用固定白名单", () => {
    assert.deepEqual(AI_RUN_PROVIDERS, ["codex", "claude", "kimi", "gemini", "antigravity", "grok"]);
    assert.deepEqual(AI_RUN_TEMPLATE_IDS, [
      "analyze-topic",
      "break-down-content",
      "draft-article",
      "draft-video",
      "review-content",
      "analyze-account",
      "review-day",
      "plan-tomorrow",
    ]);
    assert.deepEqual(AI_RUN_STATUSES, [
      "queued",
      "running",
      "waiting_permission",
      "completed",
      "failed",
      "cancelled",
    ]);
  });

  test("schema v1 升级后保留旧 Gemini 记录并允许新增 Antigravity", async () => {
    const { parent, stateRoot } = await makeRoot();
    const initial = createAiRunMetadataDb({ stateRoot });
    const legacy = createRun(initial, parent, { provider: "gemini" });
    initial.close();

    const dbPath = path.join(stateRoot, AI_RUN_METADATA_DATABASE_NAME);
    const legacyDb = new Database(dbPath);
    legacyDb.pragma("foreign_keys = OFF");
    legacyDb.exec(`
      CREATE TABLE runs_v1 (
        run_id TEXT PRIMARY KEY CHECK(length(run_id) = 40),
        provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude', 'kimi', 'gemini', 'grok')),
        template_id TEXT,
        permission_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        title TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        error_summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      ) STRICT;
      INSERT INTO runs_v1 SELECT * FROM runs;
      DROP TABLE runs;
      ALTER TABLE runs_v1 RENAME TO runs;
      CREATE INDEX runs_updated ON runs(updated_at DESC, run_id);
      CREATE INDEX runs_provider_status ON runs(provider, status, updated_at DESC);
      PRAGMA user_version = 1;
    `);
    legacyDb.close();

    const migrated = track(createAiRunMetadataDb({ stateRoot }));
    assert.equal(migrated.getRun(legacy.runId).provider, "gemini");
    const current = createRun(migrated, parent, { provider: "antigravity" });
    assert.equal(current.provider, "antigravity");
    const inspector = new Database(dbPath, { readonly: true });
    try { assert.equal(inspector.pragma("user_version", { simple: true }), 2); }
    finally { inspector.close(); }
  });

  test("运行、事件和导入元数据在重启后恢复，工作区路径保持证据关联", async () => {
    const { parent, stateRoot } = await makeRoot();
    const first = track(createAiRunMetadataDb({ stateRoot }));
    const created = createRun(first, parent, { provider: "kimi", templateId: "draft-article" });
    first.updateRun(created.runId, { status: "running" });
    first.appendEvent(created.runId, { type: "message", text: "开始分析" });
    first.recordImport({
      runId: created.runId,
      targetRef: "30-内容资产/01-文章/测试稿.md",
      status: "confirmed",
      sha256: "a".repeat(64),
      details: { assetId: "content-1" },
    });
    first.close();

    const second = track(createAiRunMetadataDb({ stateRoot }));
    const recovered = second.getRun(created.runId);
    assert.equal(recovered.status, "running");
    assert.equal(recovered.provider, "kimi");
    assert.equal(recovered.templateId, "draft-article");
    assert.equal(recovered.workspacePath, created.workspacePath);
    assert.deepEqual(second.listEvents(created.runId).map((event) => event.seq), [1]);
    assert.equal(second.listRuns({ provider: "kimi" }).total, 1);
  });

  test("两个连接并发追加事件时 seq 对每个 run 严格递增且唯一", async () => {
    const { parent, stateRoot } = await makeRoot();
    const store = track(createAiRunMetadataDb({ stateRoot }));
    const run = createRun(store, parent);
    const source = `
      const { parentPort, workerData } = require("node:worker_threads");
      (async () => {
        try {
          const { createAiRunMetadataDb } = await import(workerData.moduleUrl);
          const db = createAiRunMetadataDb({ stateRoot: workerData.stateRoot });
          for (let index = 0; index < workerData.count; index += 1) {
            db.appendEvent(workerData.runId, {
              type: "message",
              text: workerData.label + "-" + index,
            });
          }
          db.close();
          parentPort.postMessage({ ok: true });
        } catch (error) {
          parentPort.postMessage({ ok: false, error: error.stack || error.message });
        }
      })();
    `;
    const workers = ["left", "right"].map((label) => new Worker(source, {
      eval: true,
      workerData: { moduleUrl, stateRoot, runId: run.runId, count: 30, label },
    }));
    await Promise.all(workers.map(workerResult));

    const events = store.listEvents(run.runId, { limit: 100 });
    assert.equal(events.length, 60);
    assert.deepEqual(events.map((event) => event.seq), Array.from({ length: 60 }, (_, index) => index + 1));
    assert.equal(new Set(events.map((event) => event.id)).size, 60);
  });

  test("状态机拒绝跳步和终态复活", async () => {
    const { parent, stateRoot } = await makeRoot();
    const store = track(createAiRunMetadataDb({ stateRoot }));
    const run = createRun(store, parent);

    assert.throws(
      () => store.updateRun(run.runId, { status: "completed" }),
      AiRunMetadataStateError,
    );
    assert.throws(
      () => store.updateRun(run.runId, { status: "waiting_permission" }),
      AiRunMetadataStateError,
    );
    assert.equal(store.updateRun(run.runId, { status: "running" }).status, "running");
    assert.equal(store.updateRun(run.runId, { status: "completed" }).status, "completed");
    assert.throws(
      () => store.updateRun(run.runId, { status: "running" }),
      AiRunMetadataStateError,
    );
  });

  test("所有 JSON 元数据先脱敏，原始环境变量拒绝入库", async () => {
    const { parent, stateRoot } = await makeRoot();
    const store = track(createAiRunMetadataDb({ stateRoot }));
    const secretA = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    const secretB = "cookie-session-should-not-persist";
    const run = createRun(store, parent, {
      metadata: {
        token: secretA,
        nested: {
          cookie: secretB,
          sessionToken: secretA,
          note: `Authorization: Bearer ${secretA}`,
        },
      },
    });
    assert.equal(run.metadata.token, "[REDACTED]");
    assert.equal(run.metadata.nested.cookie, "[REDACTED]");
    assert.equal(run.metadata.nested.sessionToken, "[REDACTED]");
    assert.doesNotMatch(run.metadata.nested.note, /ghp_/);

    const event = store.appendEvent(run.runId, {
      type: "message",
      text: `api_key=${secretA} token=${secretB}`,
      details: { access_token: secretA, cookie: secretB },
    });
    assert.doesNotMatch(event.text, /ghp_/);
    assert.doesNotMatch(event.text, /cookie-session-should-not-persist/);
    assert.equal(event.details.access_token, "[REDACTED]");
    assert.equal(event.details.cookie, "[REDACTED]");
    const failed = store.updateRun(run.runId, {
      status: "failed",
      errorSummary: `secret=${secretB}`,
    });
    assert.doesNotMatch(failed.errorSummary, /cookie-session-should-not-persist/);

    assert.throws(
      () => createRun(store, parent, { metadata: { env: { API_KEY: secretA } } }),
      AiRunMetadataSecurityError,
    );
    assert.throws(
      () => createRun(store, parent, { metadata: { rawEnvironment: { API_KEY: secretA } } }),
      AiRunMetadataSecurityError,
    );
    store.close();
    const bytes = await fs.readFile(path.join(stateRoot, AI_RUN_METADATA_DATABASE_NAME));
    assert.equal(bytes.includes(Buffer.from(secretA)), false);
    assert.equal(bytes.includes(Buffer.from(secretB)), false);
  });

  test("stateRoot 的直接父目录为软链接时拒绝建库", async (context) => {
    if (process.platform === "win32") context.skip("Windows symlink semantics differ");
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cockpit-ai-metadata-link-"));
    temporaryDirectories.push(parent);
    const realParent = path.join(parent, "real-parent");
    const linkedParent = path.join(parent, "linked-parent");
    await fs.mkdir(realParent);
    await fs.symlink(realParent, linkedParent, "dir");
    assert.throws(
      () => createAiRunMetadataDb({ stateRoot: path.join(linkedParent, "state") }),
      AiRunMetadataSecurityError,
    );
    await assert.rejects(fs.access(path.join(realParent, "state")));
  });

  test("权限请求只允许解决一次，解决后运行从等待态回到运行态", async () => {
    const { parent, stateRoot } = await makeRoot();
    const store = track(createAiRunMetadataDb({ stateRoot }));
    const run = createRun(store, parent, { provider: "claude", templateId: "review-day" });
    store.updateRun(run.runId, { status: "running" });
    const permission = store.createPermission({
      runId: run.runId,
      toolCallId: "tool-call-1",
      title: "允许写入临时输出？",
      kind: "workspace-write",
      request: { target: "outputs/draft.md", api_key: "not-for-storage" },
    });
    assert.equal(permission.status, "pending");
    assert.equal(permission.request.api_key, "[REDACTED]");
    assert.equal(store.getRun(run.runId).status, "waiting_permission");

    const resolved = store.resolvePermission(permission.permissionId, {
      decision: "allow_once",
      details: { actor: "human", token: "never-store-this" },
    });
    assert.equal(resolved.status, "allowed");
    assert.equal(resolved.decision, "allow_once");
    assert.equal(resolved.resolution.token, "[REDACTED]");
    assert.equal(store.getRun(run.runId).status, "running");
    assert.throws(
      () => store.resolvePermission(permission.permissionId, { decision: "reject_once" }),
      AiRunPermissionResolvedError,
    );
  });

  test("字段大小、JSON schema、provider 与模板输入在边界层拒绝", async () => {
    const { parent, stateRoot } = await makeRoot();
    const store = track(createAiRunMetadataDb({ stateRoot }));
    assert.throws(
      () => createRun(store, parent, { provider: "unknown" }),
      AiRunMetadataValidationError,
    );
    assert.throws(
      () => createRun(store, parent, { templateId: "arbitrary-prompt" }),
      AiRunMetadataValidationError,
    );
    assert.throws(
      () => createRun(store, parent, { metadata: [] }),
      AiRunMetadataValidationError,
    );
    assert.throws(
      () => createRun(store, parent, { metadata: { payload: "x".repeat(40_000) } }),
      AiRunMetadataValidationError,
    );
    const run = createRun(store, parent);
    const starting = store.appendEvent(run.runId, { type: "status", status: "starting" });
    const connected = store.appendEvent(run.runId, { type: "status", status: "connected" });
    assert.equal(starting.status, "starting");
    assert.equal(connected.status, "connected");
    assert.throws(
      () => store.updateRun(run.runId, { status: "starting" }),
      AiRunMetadataValidationError,
    );
    assert.throws(
      () => store.appendEvent(run.runId, { type: "message", unknown: true }),
      AiRunMetadataValidationError,
    );
    assert.throws(
      () => store.appendEvent(run.runId, { type: "message", text: "x".repeat(50_001) }),
      AiRunMetadataValidationError,
    );
    assert.throws(
      () => store.appendEvent(run.runId, { type: "status", status: "" }),
      AiRunMetadataValidationError,
    );
    assert.throws(
      () => store.appendEvent(run.runId, { type: "status", status: "line-one\nline-two" }),
      AiRunMetadataValidationError,
    );
    assert.throws(
      () => store.appendEvent(run.runId, { type: "status", status: "x".repeat(101) }),
      AiRunMetadataValidationError,
    );
  });

  test("高于当前版本的数据库不会被旧程序降级覆盖", async () => {
    const { stateRoot } = await makeRoot();
    await fs.mkdir(stateRoot, { mode: 0o700 });
    const dbPath = path.join(stateRoot, AI_RUN_METADATA_DATABASE_NAME);
    const future = new Database(dbPath);
    future.pragma(`user_version = ${AI_RUN_METADATA_SCHEMA_VERSION + 1}`);
    future.close();
    assert.throws(
      () => createAiRunMetadataDb({ stateRoot }),
      AiRunMetadataValidationError,
    );
  });
});
