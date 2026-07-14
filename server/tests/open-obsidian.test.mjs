import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { createOpenObsidianMiddleware, resolveAssetSource } from "../open-obsidian-api.mjs";

const temporaryDirectories = [];

async function project() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "creator-open-obsidian-"));
  temporaryDirectories.push(base);
  const root = path.join(base, "第二大脑-v2");
  const source = "30-内容资产/02-短视频口播/原文.md";
  const target = path.join(root, source);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "# 原文\n", "utf8");
  const reference = "content:content-original";
  return { base, root, source, target, reference };
}

async function withServer(options, run) {
  const middleware = createOpenObsidianMiddleware(options);
  const server = http.createServer((request, response) => middleware(request, response, () => {
    response.statusCode = 404;
    response.end("not found");
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("Obsidian 原文打开接口", () => {
  test("review 引用同时解析待确认与已确认集合，并拒绝任意形式的重复 id", async () => {
    const value = await project();
    const indexPath = path.join(value.base, "index.json");
    const writeIndex = (index) => fs.writeFile(indexPath, JSON.stringify(index), "utf8");

    await writeIndex({
      reviewItems: [{ id: "pending-review", type: "复盘", source: "20-知识资产/复盘/待确认.md" }],
      knowledge: [{ id: "confirmed-review", type: "复盘", source: "20-知识资产/复盘/已确认.md" }],
    });
    assert.equal(resolveAssetSource(indexPath, "review:pending-review"), "20-知识资产/复盘/待确认.md");
    assert.equal(resolveAssetSource(indexPath, "review:confirmed-review"), "20-知识资产/复盘/已确认.md");

    const duplicateIndexes = [
      {
        reviewItems: [
          { id: "duplicate-review", type: "复盘", source: "20-知识资产/复盘/待确认-a.md" },
          { id: "duplicate-review", type: "复盘", source: "20-知识资产/复盘/待确认-b.md" },
        ],
        knowledge: [],
      },
      {
        reviewItems: [],
        knowledge: [
          { id: "duplicate-review", type: "复盘", source: "20-知识资产/复盘/已确认-a.md" },
          { id: "duplicate-review", type: "复盘", source: "20-知识资产/复盘/已确认-b.md" },
        ],
      },
      {
        reviewItems: [{ id: "duplicate-review", type: "复盘", source: "20-知识资产/复盘/待确认.md" }],
        knowledge: [{ id: "duplicate-review", type: "复盘", source: "20-知识资产/复盘/已确认.md" }],
      },
    ];
    for (const index of duplicateIndexes) {
      await writeIndex(index);
      assert.throws(
        () => resolveAssetSource(indexPath, "review:duplicate-review"),
        /复盘原文引用不唯一/,
      );
    }

    for (const index of [
      { reviewItems: [{ id: "ordinary", type: "实验", source: "00-收件箱/实验.md" }], knowledge: [] },
      { reviewItems: [], knowledge: [{ id: "ordinary", type: "方法", source: "20-知识资产/方法.md" }] },
    ]) {
      await writeIndex(index);
      assert.throws(
        () => resolveAssetSource(indexPath, "review:ordinary"),
        /未指向复盘资产/,
      );
    }
  });

  test("只把 V2 内真实 Markdown 转成 path URI", async () => {
    const value = await project();
    const calls = [];
    await withServer({ root: value.root, resolveSource: () => value.source, openFile: async (input) => calls.push(input) }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/open-obsidian`, {
        method: "POST",
        headers: {
          Origin: baseUrl,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ source: value.reference }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { opened: true });
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].target, value.target);
    assert.equal(calls[0].uri, `obsidian://open?path=${encodeURIComponent(value.target)}`);
  });

  test("允许前端用 V2 内安全 Markdown 相对路径打开每日复盘或 AI 成果", async () => {
    const value = await project();
    const calls = [];
    await withServer({ root: value.root, openFile: async (input) => calls.push(input) }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/open-obsidian`, {
        method: "POST",
        headers: { Origin: baseUrl, "Content-Type": "application/json" },
        body: JSON.stringify({ source: value.source }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { opened: true });
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].target, value.target);
  });

  test("自定义状态目录中的索引可用于打开原文", async () => {
    const value = await project();
    const stateRoot = path.join(value.base, "custom-state");
    await fs.mkdir(stateRoot, { recursive: true });
    await fs.writeFile(path.join(stateRoot, "index.json"), JSON.stringify({
      contents: [{ id: "content-original", source: value.source }],
      knowledge: [],
      projectDocuments: [],
      evidence: [],
      reviewItems: [],
    }), "utf8");
    const calls = [];

    await withServer({ root: value.root, stateRoot, openFile: async (input) => calls.push(input) }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/open-obsidian`, {
        method: "POST",
        headers: {
          Origin: baseUrl,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ source: value.reference }),
      });
      assert.equal(response.status, 200);
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].target, value.target);
  });

  test("拒绝路径穿越、软链接、缺失文件和非同源请求", async () => {
    const value = await project();
    const outside = path.join(value.base, "outside.md");
    await fs.writeFile(outside, "# 外部\n", "utf8");
    await fs.symlink(outside, path.join(value.root, "伪装.md"));
    const calls = [];
    const sourceMap = new Map([
      ["content:content-original", value.source],
      ["content:content-traversal", "../outside.md"],
      ["content:content-symlink", "伪装.md"],
      ["content:content-missing", "缺失.md"],
    ]);
    await withServer({ root: value.root, resolveSource: (reference) => sourceMap.get(reference) ?? value.source, openFile: async (input) => calls.push(input) }, async (baseUrl) => {
      const request = (source, origin = baseUrl) => fetch(`${baseUrl}/api/open-obsidian`, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ source }),
      });
      assert.equal((await request("content:content-traversal")).status, 403);
      assert.equal((await request("content:content-symlink")).status, 403);
      assert.equal((await request("content:content-missing")).status, 404);
      assert.equal((await request(value.reference, "http://evil.example")).status, 403);
      assert.equal((await request("../outside.md")).status, 400);
      assert.equal((await request("/etc/passwd.md")).status, 400);
      assert.equal((await request("30-内容资产\\伪装.md")).status, 400);
      assert.equal((await fetch(`${baseUrl}/api/open-obsidian?source=x`)).status, 403);
    });
    assert.equal(calls.length, 0);
  });
});
