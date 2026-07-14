import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { createDailyTasksMiddleware } from "../daily-tasks-api.mjs";
import { createCockpitSettingsStore } from "../cockpit-settings-store.mjs";
import {
  createDailyTasksStore,
  DAILY_TASKS_RELATIVE_DIR,
  DailyTasksCommitError,
  DailyTasksConflictError,
  DailyTasksSecurityError,
  DailyTasksValidationError,
  parseDailyTasksMarkdown,
  serializeDailyTasksMarkdown,
  shanghaiDate,
  validateDate,
} from "../daily-tasks-store.mjs";

const DATE = "2026-07-12";
const FIXED_NOW = new Date("2026-07-12T02:03:04.567Z");
const temporaryDirectories = [];

async function temporaryProject() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "creator-daily-tasks-"));
  temporaryDirectories.push(base);
  return {
    base,
    root: path.join(base, "第二大脑-v2"),
    stateRoot: path.join(base, ".media-growth-cockpit"),
  };
}

function sampleTasks(suffix = "") {
  return [
    { id: "today-2026-07-12-1", title: `发布公众号文章${suffix}`, done: false },
    { id: "today-2026-07-12-2", title: "完成短视频脚本", done: true },
    { id: "today-2026-07-12-3", title: "复盘昨日内容数据", done: false },
  ];
}

function linkedSampleTasks() {
  return [
    { ...sampleTasks()[0], linkType: "topic", linkId: "topic-ai-workflow" },
    { ...sampleTasks()[1], linkType: "content", linkId: "content-short-video" },
    { ...sampleTasks()[2], linkType: "daily-review", linkId: "daily-review-2026-07-11" },
  ];
}

function createStore(project, options = {}) {
  return createDailyTasksStore({
    root: project.root,
    stateRoot: project.stateRoot,
    now: () => FIXED_NOW,
    afterWrite: async () => {},
    ...options,
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("日期与 Markdown 解析", () => {
  test("上海时区日期由服务器计算", () => {
    assert.equal(shanghaiDate(new Date("2026-07-11T16:01:00.000Z")), "2026-07-12");
    assert.equal(validateDate("2024-02-29"), "2024-02-29");
    assert.throws(() => validateDate("2026-02-30"), DailyTasksValidationError);
    assert.throws(() => validateDate("../../etc/passwd"), DailyTasksValidationError);
  });

  test("兼容 task 与 task-id 隐藏标记，并保留 frontmatter", () => {
    const markdown = `---
id: daily-tasks-2026-07-12
type: 任务日志
custom_field: 保留我
topics: [AI博主, 每日执行]
---

# 2026-07-12 今日三件事

- [ ] 第一条 <!-- task:today-2026-07-12-1 -->
- [x] 第二条 <!-- task-id:today-2026-07-12-2 -->
`;
    const parsed = parseDailyTasksMarkdown(markdown);
    assert.equal(parsed.frontmatter.custom_field, "保留我");
    assert.deepEqual(parsed.frontmatter.topics, ["AI博主", "每日执行"]);
    assert.deepEqual(parsed.tasks, [
      { id: "today-2026-07-12-1", title: "第一条", done: false, linkId: null, linkType: null },
      { id: "today-2026-07-12-2", title: "第二条", done: true, linkId: null, linkType: null },
    ]);

    const serialized = serializeDailyTasksMarkdown({
      date: DATE,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      tasks: parsed.tasks,
    });
    assert.match(serialized, /custom_field: 保留我/);
    assert.match(serialized, /type: 任务日志/);
    assert.match(serialized, /<!-- task:today-2026-07-12-1 -->/);
  });

  test("Obsidian 手工新增的无标记任务会获得稳定安全 ID", () => {
    const markdown = `---\ntype: 任务日志\ndate: 2026-07-12\nconfirmation: 已确认\n---\n\n- [ ] 手工新增任务\n`;
    const first = parseDailyTasksMarkdown(markdown);
    const second = parseDailyTasksMarkdown(markdown);
    assert.match(first.tasks[0].id, /^manual-[a-f0-9]{20}$/);
    assert.equal(first.tasks[0].id, second.tasks[0].id);
  });

  test("task_links 按任务 ID 保留六种允许的资产关系", () => {
    const allowed = ["topic", "content", "content-review", "account-breakdown", "daily-review", "task"];
    for (const linkType of allowed) {
      const task = {
        id: `task-${linkType.replaceAll("-", "_")}`,
        title: `关联 ${linkType}`,
        done: false,
        linkType,
        linkId: `asset-${linkType.replaceAll("-", "_")}`,
      };
      const serialized = serializeDailyTasksMarkdown({ date: DATE, tasks: [task] });
      const parsed = parseDailyTasksMarkdown(serialized);
      assert.deepEqual(parsed.tasks, [task]);
      assert.deepEqual(parsed.frontmatter.task_links[task.id], { type: linkType, id: task.linkId });
    }
  });

  test("删除任务时序列化会移除孤立 task_links 映射", () => {
    const initial = serializeDailyTasksMarkdown({ date: DATE, tasks: linkedSampleTasks() });
    const parsed = parseDailyTasksMarkdown(initial);
    const remaining = parsed.tasks.slice(0, 2);
    const next = serializeDailyTasksMarkdown({
      date: DATE,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      tasks: remaining,
    });
    const reparsed = parseDailyTasksMarkdown(next);
    assert.deepEqual(reparsed.tasks, remaining);
    assert.equal(Object.hasOwn(reparsed.frontmatter.task_links, "today-2026-07-12-3"), false);
  });

  test("拒绝半条关系、未知类型、路径字段和非法 task_links", () => {
    assert.throws(() => serializeDailyTasksMarkdown({
      date: DATE,
      tasks: [{ ...sampleTasks()[0], linkType: "content", linkId: null }],
    }), DailyTasksValidationError);
    assert.throws(() => serializeDailyTasksMarkdown({
      date: DATE,
      tasks: [{ ...sampleTasks()[0], linkType: "unknown", linkId: "asset-1" }],
    }), DailyTasksValidationError);
    assert.throws(() => serializeDailyTasksMarkdown({
      date: DATE,
      tasks: [{ ...sampleTasks()[0], linkType: "content", linkId: "asset-1", path: "../../secret.md" }],
    }), DailyTasksValidationError);
    assert.throws(() => parseDailyTasksMarkdown(`---\ntype: 任务日志\ndate: ${DATE}\ntask_links:\n  today-2026-07-12-1:\n    type: content\n    id: asset-1\n    path: ../../secret.md\n---\n\n- [ ] 第一条 <!-- task:today-2026-07-12-1 -->\n`), DailyTasksValidationError);
  });
});

describe("安全存储", () => {
  test("创建、读取并以 SHA-256 做乐观锁", async () => {
    const project = await temporaryProject();
    const store = createStore(project);
    const saved = await store.write(DATE, sampleTasks(), null);
    assert.equal(saved.date, DATE);
    assert.equal(saved.tasks.length, 3);
    assert.match(saved.hash, /^[a-f0-9]{64}$/);
    assert.equal(saved.notFound, false);

    const contents = await fs.readFile(store.filePathForDate(DATE), "utf8");
    assert.match(contents, /<!-- task:today-2026-07-12-1 -->/);
    assert.match(contents, /type: 任务日志/);

    await assert.rejects(
      store.write(DATE, sampleTasks("（旧页面）"), "0".repeat(64)),
      (error) => error instanceof DailyTasksConflictError && error.current.hash === saved.hash,
    );
    const unchanged = await store.read(DATE);
    assert.equal(unchanged.hash, saved.hash);
  });

  test("写入和读取不会丢失任务资产关系", async () => {
    const project = await temporaryProject();
    const store = createStore(project);
    const saved = await store.write(DATE, linkedSampleTasks(), null);
    assert.deepEqual(saved.tasks, linkedSampleTasks());

    const contents = await fs.readFile(store.filePathForDate(DATE), "utf8");
    assert.match(contents, /task_links:/);
    assert.match(contents, /type: topic/);
    assert.match(contents, /id: topic-ai-workflow/);
    assert.deepEqual((await store.read(DATE)).tasks, linkedSampleTasks());
  });

  test("同一旧哈希的并发写入只允许一个成功", async () => {
    const project = await temporaryProject();
    const store = createStore(project);
    const initial = await store.write(DATE, sampleTasks(), null);
    const outcomes = await Promise.allSettled([
      store.write(DATE, sampleTasks("（网页A）"), initial.hash),
      store.write(DATE, sampleTasks("（网页B）"), initial.hash),
    ]);
    assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
    const rejection = outcomes.find((item) => item.status === "rejected");
    assert.ok(rejection && rejection.reason instanceof DailyTasksConflictError);
  });

  test("两个任务 store 实例写同一文件时共享乐观锁队列", async () => {
    const project = await temporaryProject();
    const initialStore = createStore(project);
    const initial = await initialStore.write(DATE, sampleTasks(), null);
    const storeA = createStore(project);
    const storeB = createStore(project);

    const outcomes = await Promise.allSettled([
      storeA.write(DATE, sampleTasks("（实例A）"), initial.hash),
      storeB.write(DATE, sampleTasks("（实例B）"), initial.hash),
    ]);

    const fulfilled = outcomes.filter((item) => item.status === "fulfilled");
    const rejected = outcomes.filter((item) => item.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof DailyTasksConflictError);
    assert.equal(rejected[0].reason.current.hash, fulfilled[0].value.hash);
  });

  test("拒绝超过三条、重复 ID、注入式标题和非法哈希", async () => {
    const project = await temporaryProject();
    const store = createStore(project);
    await assert.rejects(store.write(DATE, [...sampleTasks(), { id: "four", title: "第四条", done: false }], null), DailyTasksValidationError);
    await assert.rejects(store.write(DATE, [sampleTasks()[0], sampleTasks()[0]], null), DailyTasksValidationError);
    await assert.rejects(store.write(DATE, [{ id: "safe", title: "标题\n- [ ] 注入", done: false }], null), DailyTasksValidationError);
    await assert.rejects(store.write(DATE, [{ id: "safe", title: "[[隐私文件]]", done: false }], null), DailyTasksValidationError);
    await assert.rejects(store.write(DATE, [{ id: "safe", title: "<script>alert(1)</script>", done: false }], null), DailyTasksValidationError);
    await assert.rejects(store.write(DATE, sampleTasks(), "not-a-hash"), DailyTasksValidationError);
  });

  test("拒绝白名单目录软链接和目标文件软链接", async () => {
    const project = await temporaryProject();
    const outside = path.join(project.base, "outside");
    await fs.mkdir(outside, { recursive: true });
    const parent = path.join(project.root, path.dirname(DAILY_TASKS_RELATIVE_DIR));
    await fs.mkdir(parent, { recursive: true });
    await fs.symlink(outside, path.join(project.root, DAILY_TASKS_RELATIVE_DIR));
    const directoryStore = createStore(project);
    await assert.rejects(directoryStore.write(DATE, sampleTasks(), null), DailyTasksSecurityError);

    await fs.rm(path.join(project.root, DAILY_TASKS_RELATIVE_DIR));
    const targetDir = path.join(project.root, DAILY_TASKS_RELATIVE_DIR);
    await fs.mkdir(targetDir, { recursive: true });
    const outsideFile = path.join(outside, "outside.md");
    await fs.writeFile(outsideFile, "不得修改", "utf8");
    await fs.symlink(outsideFile, path.join(targetDir, `${DATE}-今日三件事.md`));
    const fileStore = createStore(project);
    await assert.rejects(fileStore.read(DATE), DailyTasksSecurityError);
    assert.equal(await fs.readFile(outsideFile, "utf8"), "不得修改");
  });

  test("拒绝状态根目录软链接，且不会把任务或审计写到链外", async () => {
    const project = await temporaryProject();
    const outsideState = path.join(project.base, "outside-state");
    await fs.mkdir(outsideState, { recursive: true });
    await fs.symlink(outsideState, project.stateRoot);
    const store = createStore(project);

    await assert.rejects(store.write(DATE, sampleTasks(), null), DailyTasksSecurityError);

    assert.deepEqual(await fs.readdir(outsideState), []);
    await assert.rejects(fs.access(store.filePathForDate(DATE)), { code: "ENOENT" });
  });

  test("拒绝经软链接父目录创建状态根目录", async () => {
    const project = await temporaryProject();
    const outsideParent = path.join(project.base, "outside-state-parent");
    const linkedParent = path.join(project.base, "linked-state-parent");
    await fs.mkdir(outsideParent, { recursive: true });
    await fs.symlink(outsideParent, linkedParent);
    const linkedProject = {
      ...project,
      stateRoot: path.join(linkedParent, "nested-state"),
    };
    const store = createStore(linkedProject);

    await assert.rejects(store.write(DATE, sampleTasks(), null), DailyTasksSecurityError);

    assert.deepEqual(await fs.readdir(outsideParent), []);
    await assert.rejects(fs.access(store.filePathForDate(DATE)), { code: "ENOENT" });
  });

  test("拒绝软链接审计父目录，并在修改任务前停止", async () => {
    const project = await temporaryProject();
    const outsideAudit = path.join(project.base, "outside-audit");
    await fs.mkdir(outsideAudit, { recursive: true });
    await fs.mkdir(project.stateRoot, { recursive: true });
    await fs.symlink(outsideAudit, path.join(project.stateRoot, "audit"));
    const store = createStore(project);

    await assert.rejects(store.write(DATE, sampleTasks(), null), DailyTasksSecurityError);

    assert.deepEqual(await fs.readdir(outsideAudit), []);
    await assert.rejects(fs.access(store.filePathForDate(DATE)), { code: "ENOENT" });
  });

  test("覆盖前备份旧版本，审计日志不记录任务正文", async () => {
    const project = await temporaryProject();
    const store = createStore(project);
    const first = await store.write(DATE, sampleTasks(), null);
    const secondTasks = sampleTasks("（新版绝密正文）");
    await store.write(DATE, secondTasks, first.hash);

    const backupDirectory = path.join(project.stateRoot, "backups", "daily-tasks");
    const backups = await fs.readdir(backupDirectory);
    assert.equal(backups.length, 1);
    const backup = await fs.readFile(path.join(backupDirectory, backups[0]), "utf8");
    assert.match(backup, /发布公众号文章/);
    assert.doesNotMatch(backup, /新版绝密正文/);

    const audit = await fs.readFile(path.join(project.stateRoot, "audit", "daily-tasks.jsonl"), "utf8");
    assert.doesNotMatch(audit, /发布公众号文章|新版绝密正文|完成短视频脚本/);
    assert.match(audit, /"status":"success"/);
  });

  test("网页更新任务时保留 Obsidian 中的非任务正文", async () => {
    const project = await temporaryProject();
    const store = createStore(project);
    const first = await store.write(DATE, sampleTasks(), null);
    const filePath = store.filePathForDate(DATE);
    await fs.appendFile(filePath, "\n## 今日备注\n\n这段只在 Obsidian 中维护，网页更新任务时必须保留。\n\n- [ ] 备注区检查项不能被当成今日三件事\n", "utf8");
    const current = await store.read(DATE);

    await store.write(DATE, sampleTasks("（已调整）"), current.hash);

    const contents = await fs.readFile(filePath, "utf8");
    assert.match(contents, /## 今日备注/);
    assert.match(contents, /这段只在 Obsidian 中维护，网页更新任务时必须保留。/);
    assert.match(contents, /- \[ \] 备注区检查项不能被当成今日三件事/);
    assert.match(contents, /发布公众号文章（已调整）/);
    assert.doesNotMatch(contents, /发布公众号文章 <!--/);
    assert.equal((await store.read(DATE)).tasks.length, 3);
    assert.notEqual(current.hash, first.hash);
  });

  test("同一任务服务在设置更新后立即使用新项目目录和使用者", async () => {
    const project = await temporaryProject();
    await fs.mkdir(project.root, { recursive: true });
    const settingsStore = createCockpitSettingsStore({
      root: project.root,
      stateRoot: project.stateRoot,
      now: () => FIXED_NOW,
      afterWrite: async () => {},
    });
    const baseSettings = {
      productName: "创作者驾驶舱",
      ownerName: "旧使用者",
      creatorPositioning: "科普博主",
      campaignName: "增长计划",
      growthTarget: 10_000,
      startDate: null,
      deadline: null,
      projectRelativeDir: "50-进行中项目/旧项目",
      baselineDate: DATE,
      baselineRelativePath: `60-数据与看板/01-内容数据/${DATE}-平台粉丝基线.md`,
    };
    const initialSettings = await settingsStore.write(baseSettings, null);
    const store = createStore(project);
    await settingsStore.write({ ...baseSettings, ownerName: "新使用者", projectRelativeDir: "50-进行中项目/新项目" }, initialSettings.hash);

    await store.write(DATE, sampleTasks(), null);

    const newPath = path.join(project.root, "50-进行中项目/新项目/07-每日任务", `${DATE}-今日三件事.md`);
    assert.equal(store.filePathForDate(DATE), newPath);
    assert.match(await fs.readFile(newPath, "utf8"), /origin_owner: 新使用者/);
    await assert.rejects(
      fs.access(path.join(project.root, "50-进行中项目/旧项目/07-每日任务", `${DATE}-今日三件事.md`)),
      { code: "ENOENT" },
    );
  });

  test("索引校验失败时恢复旧文件并再次重建旧索引", async () => {
    const project = await temporaryProject();
    const stableStore = createStore(project);
    const first = await stableStore.write(DATE, sampleTasks(), null);
    let attempts = 0;
    const failingStore = createStore(project, {
      afterWrite: async ({ rollback }) => {
        attempts += 1;
        if (!rollback) throw new Error("模拟索引校验失败");
      },
    });

    await assert.rejects(
      failingStore.write(DATE, sampleTasks("（不应保留）"), first.hash),
      (error) => error instanceof DailyTasksCommitError && !error.rollbackError,
    );
    assert.equal(attempts, 2);
    const restored = await stableStore.read(DATE);
    assert.equal(restored.hash, first.hash);
    assert.equal(restored.tasks[0].title, "发布公众号文章");
  });
});

describe("HTTP API 边界", () => {
  async function withServer(project, run) {
    const store = createStore(project);
    const middleware = createDailyTasksMiddleware({ store, now: () => FIXED_NOW });
    const server = http.createServer((request, response) => {
      middleware(request, response, () => {
        response.statusCode = 404;
        response.end("not found");
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    try {
      await run(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }

  test("GET 不存在返回正常空状态；PUT 后返回服务端当天快照", async () => {
    const project = await temporaryProject();
    await withServer(project, async (baseUrl) => {
      const missing = await fetch(`${baseUrl}/api/daily-tasks`);
      assert.equal(missing.status, 200);
      assert.equal((await missing.json()).notFound, true);

      const saved = await fetch(`${baseUrl}/api/daily-tasks`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: baseUrl },
        body: JSON.stringify({ tasks: sampleTasks(), expectedHash: null }),
      });
      assert.equal(saved.status, 200);
      const snapshot = await saved.json();
      assert.equal(snapshot.date, DATE);
      assert.equal(snapshot.tasks.length, 3);
      assert.equal(snapshot.tasks[0].linkId, null);

      const roundTrip = await fetch(`${baseUrl}/api/daily-tasks`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: baseUrl },
        body: JSON.stringify({ tasks: snapshot.tasks, expectedHash: snapshot.hash }),
      });
      assert.equal(roundTrip.status, 200);
    });
  });

  test("PUT 往返保留关系且拒绝浏览器提交路径", async () => {
    const project = await temporaryProject();
    await withServer(project, async (baseUrl) => {
      const saved = await fetch(`${baseUrl}/api/daily-tasks`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: baseUrl },
        body: JSON.stringify({ tasks: linkedSampleTasks(), expectedHash: null }),
      });
      assert.equal(saved.status, 200);
      const snapshot = await saved.json();
      assert.deepEqual(snapshot.tasks, linkedSampleTasks());

      const rejected = await fetch(`${baseUrl}/api/daily-tasks`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: baseUrl },
        body: JSON.stringify({
          tasks: [{ ...linkedSampleTasks()[0], path: "../../secret.md" }],
          expectedHash: snapshot.hash,
        }),
      });
      assert.equal(rejected.status, 400);
      assert.deepEqual((await (await fetch(`${baseUrl}/api/daily-tasks`)).json()).tasks, linkedSampleTasks());
    });
  });

  test("拒绝日期参数、非 JSON、恶意 Origin 与恶意 Host", async () => {
    const project = await temporaryProject();
    await withServer(project, async (baseUrl) => {
      const query = await fetch(`${baseUrl}/api/daily-tasks?date=${DATE}`);
      assert.equal(query.status, 400);

      const wrongType = await fetch(`${baseUrl}/api/daily-tasks`, {
        method: "PUT",
        headers: { "Content-Type": "text/plain", Origin: baseUrl },
        body: "{}",
      });
      assert.equal(wrongType.status, 400);

      const missingOrigin = await fetch(`${baseUrl}/api/daily-tasks`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tasks: [], expectedHash: null }),
      });
      assert.equal(missingOrigin.status, 403);

      const evilOrigin = await fetch(`${baseUrl}/api/daily-tasks`, { headers: { Origin: "https://evil.example" } });
      assert.equal(evilOrigin.status, 403);

      const address = new URL(baseUrl);
      const evilHostStatus = await new Promise((resolve, reject) => {
        const request = http.request({
          hostname: "127.0.0.1",
          port: Number(address.port),
          path: "/api/daily-tasks",
          headers: { Host: "evil.example" },
        }, (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        });
        request.on("error", reject);
        request.end();
      });
      assert.equal(evilHostStatus, 403);
    });
  });
});
