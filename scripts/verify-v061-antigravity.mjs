import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentCatalogService } from "../server/agent-catalog.mjs";
import { createProviderLaunch } from "../server/ai-collaboration/acp-runner.mjs";
import { createAntigravityConversationRunner } from "../server/ai-collaboration/antigravity-conversation-runner.mjs";

const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "creator-v061-antigravity-"));
const marker = `V061-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
let runner;
let providerSessionId = null;

try {
  const catalog = await createAgentCatalogService().list();
  const agent = catalog.agents.find((candidate) => candidate.id === "antigravity");
  if (!agent?.installed || agent.status !== "ready" || agent.authStatus !== "ready") {
    throw new Error(`Antigravity 当前不可用：${agent?.status ?? "missing"}/${agent?.authStatus ?? "unknown"}`);
  }

  runner = createAntigravityConversationRunner({
    launch: createProviderLaunch(agent, { permissionMode: "readonly" }),
    cwd: workspace,
    permissionMode: "readonly",
    turnTimeoutMs: 120_000,
    onSession(session) { providerSessionId = session.providerSessionId; },
  });

  const first = await runner.prompt({
    text: `请记住这个随机标记，只回复标记本身：${marker}`,
  });
  if (!first.finalText.includes(marker)) throw new Error("Antigravity 首轮没有返回随机标记");

  const second = await runner.prompt({
    text: "请只回复上一轮让我记住的随机标记。",
  });
  if (!second.finalText.includes(marker)) throw new Error("Antigravity 第二轮没有恢复首轮上下文");
  if (!providerSessionId) throw new Error("Antigravity 没有返回可恢复的 Conversation ID");

  const workspaceEntries = await fs.readdir(workspace);
  if (workspaceEntries.length > 0) throw new Error("只读验证期间 Antigravity 向工作区写入了文件");

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    provider: "antigravity",
    providerVersion: agent.version,
    twoTurnContextRecovered: true,
    providerSessionPersisted: true,
    workspaceStayedEmpty: true,
  }, null, 2)}\n`);
} finally {
  await runner?.close().catch(() => {});
  await fs.rm(workspace, { recursive: true, force: true });
}
