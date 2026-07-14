import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyVaultChange,
  createVaultChangeWatcher,
  createVaultEventsHub,
} from "../vault-events.mjs";
import { ACTION_TARGETS_RELATIVE_PATH } from "../action-targets-store.mjs";
import { CONTENT_ASSETS_RELATIVE_DIR } from "../content-assets-store.mjs";
import { DAILY_TASKS_RELATIVE_DIR } from "../daily-tasks-store.mjs";
import { PLATFORM_REGISTRY_RELATIVE_PATH } from "../platform-followers-store.mjs";
import { REVIEW_ASSETS_RELATIVE_DIR } from "../review-assets-store.mjs";
import { COCKPIT_SETTINGS_RELATIVE_PATH } from "../cockpit-settings-store.mjs";

async function eventually(predicate, timeoutMs = 3_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for vault event");
}

test("classifies editable resources and sends other Markdown through the shared index", () => {
  const root = path.resolve("/tmp/v2");
  assert.deepEqual(classifyVaultChange(root, path.join(CONTENT_ASSETS_RELATIVE_DIR, "00-选题池", "选题.md")), ["content-assets"]);
  assert.deepEqual(classifyVaultChange(root, path.join(DAILY_TASKS_RELATIVE_DIR, "2026-07-13-今日三件事.md")), ["daily-tasks"]);
  assert.deepEqual(classifyVaultChange(root, ACTION_TARGETS_RELATIVE_PATH), ["action-targets"]);
  assert.deepEqual(classifyVaultChange(root, PLATFORM_REGISTRY_RELATIVE_PATH), ["platform-followers"]);
  assert.deepEqual(classifyVaultChange(root, path.join(REVIEW_ASSETS_RELATIVE_DIR, "复盘.md")), ["review-assets"]);
  assert.deepEqual(classifyVaultChange(root, COCKPIT_SETTINGS_RELATIVE_PATH), [
    "cockpit-settings",
    "daily-tasks",
    "action-targets",
  ]);
  assert.deepEqual(classifyVaultChange(root, "20-知识资产/01-判断/新判断.md"), ["index"]);
  assert.deepEqual(classifyVaultChange(root, "50-进行中项目/AI 博主 - 两个月 5 万粉/04-TASKLOG.md"), ["index"]);
  assert.deepEqual(classifyVaultChange(root, "99-系统/说明.png"), []);
  assert.deepEqual(classifyVaultChange(root, path.join(CONTENT_ASSETS_RELATIVE_DIR, ".write.tmp")), []);
});

test("settings change refreshes settings plus project-dependent task and target scopes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "creator-vault-events-settings-"));
  const settingsPath = path.join(root, COCKPIT_SETTINGS_RELATIVE_PATH);
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, "initial", "utf8");
  const published = [];
  let rebuildCount = 0;
  const watcher = createVaultChangeWatcher({
    root,
    rebuild: async () => { rebuildCount += 1; },
    publish: (scope) => published.push(scope),
  });
  try {
    await watcher.ready;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.writeFile(settingsPath, "changed", "utf8");
    await eventually(() => ["cockpit-settings", "daily-tasks", "action-targets", "index"]
      .every((scope) => published.includes(scope)));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(rebuildCount, 1);
    assert.deepEqual(new Set(published), new Set([
      "cockpit-settings",
      "daily-tasks",
      "action-targets",
      "index",
    ]));
  } finally {
    watcher.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("hub sends named SSE events to every connected page", () => {
  const writes = [];
  const hub = createVaultEventsHub({ now: () => new Date("2026-07-13T01:02:03.000Z") });
  const remove = hub.add({ destroyed: false, writableEnded: false, write: (value) => writes.push(value) });
  hub.publish("content-assets");
  hub.publish("review-assets");
  assert.equal(hub.size(), 1);
  assert.match(writes.join(""), /event: vault-change/);
  assert.match(writes.join(""), /"scope":"content-assets"/);
  assert.match(writes.join(""), /"scope":"review-assets"/);
  remove();
  assert.equal(hub.size(), 0);
});

test("filesystem change rebuilds the index and publishes resource plus index events", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "creator-vault-events-"));
  const actionPath = path.join(root, ACTION_TARGETS_RELATIVE_PATH);
  await fs.mkdir(path.dirname(actionPath), { recursive: true });
  await fs.writeFile(actionPath, "initial", "utf8");
  const published = [];
  let rebuildCount = 0;
  const watcher = createVaultChangeWatcher({
    root,
    rebuild: async () => { rebuildCount += 1; },
    publish: (scope) => published.push(scope),
  });
  try {
    await watcher.ready;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.writeFile(actionPath, "changed", "utf8");
    await eventually(() => published.includes("action-targets") && published.includes("index"));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(rebuildCount, 1);
    assert.equal(published.filter((scope) => scope === "action-targets").length, 1);
    assert.equal(published.filter((scope) => scope === "index").length, 1);
  } finally {
    watcher.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("generic knowledge change rebuilds once and publishes one index event", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "creator-vault-events-index-"));
  const knowledgePath = path.join(root, "20-知识资产", "01-判断", "判断.md");
  await fs.mkdir(path.dirname(knowledgePath), { recursive: true });
  await fs.writeFile(knowledgePath, "initial", "utf8");
  const published = [];
  let rebuildCount = 0;
  const watcher = createVaultChangeWatcher({
    root,
    rebuild: async () => { rebuildCount += 1; },
    publish: (scope) => published.push(scope),
  });
  try {
    await watcher.ready;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.writeFile(knowledgePath, "changed", "utf8");
    await eventually(() => published.includes("index"));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(rebuildCount, 1);
    assert.equal(published.filter((scope) => scope === "index").length, 1);
  } finally {
    watcher.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("watcher reconnects when the vault root appears after startup", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "creator-vault-events-reconnect-"));
  const root = path.join(base, "late-vault");
  const preparedRoot = path.join(base, "prepared-vault");
  const published = [];
  const errors = [];
  let rebuildCount = 0;
  const watcher = createVaultChangeWatcher({
    root,
    retryMs: 10,
    rebuild: async () => { rebuildCount += 1; },
    publish: (scope) => published.push(scope),
    onError: (error) => errors.push(error),
  });
  try {
    await eventually(() => errors.length > 0);
    const preparedKnowledgePath = path.join(preparedRoot, "20-知识资产", "01-判断", "新判断.md");
    await fs.mkdir(path.dirname(preparedKnowledgePath), { recursive: true });
    await fs.writeFile(preparedKnowledgePath, "initial", "utf8");
    await fs.rename(preparedRoot, root);
    await watcher.ready;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const knowledgePath = path.join(root, "20-知识资产", "01-判断", "新判断.md");
    await fs.writeFile(knowledgePath, "changed", "utf8");
    await eventually(() => published.includes("index"));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(rebuildCount, 1);
    assert.equal(published.filter((scope) => scope === "index").length, 1);
  } finally {
    watcher.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});
