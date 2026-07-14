import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentCatalogService } from "../server/agent-catalog.mjs";
import { createProviderLaunch, runAcpSession } from "../server/ai-collaboration/acp-runner.mjs";
import { createAntigravityConversationRunner } from "../server/ai-collaboration/antigravity-conversation-runner.mjs";
import { redactSensitiveString } from "../server/ai-collaboration/redaction.mjs";
import { createSafeStatePaths } from "../server/lib/safe-state-paths.mjs";

const stateRoot = path.resolve(
  process.env.COCKPIT_STATE_ROOT ?? path.join(os.homedir(), ".media-growth-cockpit"),
);
const probeRoot = path.join(stateRoot, "agent-probes");
const catalog = await createAgentCatalogService().list();
const results = [];
const safeState = createSafeStatePaths({ stateRoot, label: "Agent 验证状态" });
const providerArgument = process.argv.find((value) => value.startsWith("--provider="));
const selectedProvider = providerArgument?.slice("--provider=".length) || null;
if (selectedProvider && !["codex", "claude", "kimi", "antigravity", "grok"].includes(selectedProvider)) {
  throw new Error("--provider 只能是 codex、claude、kimi、antigravity 或 grok");
}

await safeState.ensureDirectory(probeRoot);

for (const agent of catalog.agents.filter((candidate) => !selectedProvider || candidate.id === selectedProvider)) {
  const startedAt = new Date().toISOString();
  if (!agent.installed || agent.status !== "ready") {
    results.push({
      provider: agent.id,
      displayName: agent.displayName,
      version: agent.version,
      status: "unavailable",
      reason: agent.status,
      startedAt,
      endedAt: new Date().toISOString(),
    });
    continue;
  }

  const workspace = await fs.mkdtemp(path.join(probeRoot, `${agent.id}-`));
  const events = [];
  let runner;
  try {
    const launch = createProviderLaunch(agent, { permissionMode: "readonly" });
    const onEvent = (event) => { events.push({ type: event.type, status: event.status ?? null }); };
    const result = agent.id === "antigravity"
      ? await (runner = createAntigravityConversationRunner({
        launch,
        cwd: workspace,
        permissionMode: "readonly",
        turnTimeoutMs: 90_000,
      })).prompt({
        text: "这是本机连接验证。不要使用工具，不要读取文件，只回复：连接成功。",
        onEvent,
      })
      : await runAcpSession({
        launch,
        cwd: workspace,
        prompt: "这是本机连接验证。不要使用工具，不要读取文件，只回复：连接成功。",
        permissionMode: "readonly",
        initializeTimeoutMs: 15_000,
        turnTimeoutMs: 90_000,
        onEvent,
      });
    results.push({
      provider: agent.id,
      displayName: agent.displayName,
      version: agent.version,
      latestStable: agent.latestStable,
      versionStatus: agent.versionStatus,
      status: "passed",
      protocolVersion: result.protocolVersion ?? (agent.id === "antigravity" ? "antigravity-cli" : null),
      stopReason: result.stopReason,
      response: redactSensitiveString(result.finalText).slice(0, 200),
      eventTypes: [...new Set(events.map((event) => event.type))],
      startedAt,
      endedAt: new Date().toISOString(),
    });
  } catch (error) {
    results.push({
      provider: agent.id,
      displayName: agent.displayName,
      version: agent.version,
      latestStable: agent.latestStable,
      versionStatus: agent.versionStatus,
      status: "failed",
      reason: redactSensitiveString(error?.message ?? "连接验证失败").slice(0, 500),
      eventTypes: [...new Set(events.map((event) => event.type))],
      startedAt,
      endedAt: new Date().toISOString(),
    });
  } finally {
    await runner?.close().catch(() => {});
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  automaticInstall: false,
  automaticUpgrade: false,
  results,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (results.some((result) => result.status !== "passed")) process.exitCode = 1;
