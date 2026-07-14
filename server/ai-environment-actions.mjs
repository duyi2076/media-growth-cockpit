import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createAgentCatalogService, resolveExecutable } from "./agent-catalog.mjs";
import { createMinimalRuntimeEnvironment } from "./ai-collaboration/acp-runner.mjs";

const execFileAsync = promisify(execFile);
const PROVIDERS = new Set(["codex", "claude", "kimi", "antigravity", "grok"]);
const ACTIONS = new Set(["install", "update", "login"]);
const JOB_ID_RE = /^ai-env-[0-9a-f-]{36}$/i;
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
const ACTION_TIMEOUT_MS = 10 * 60_000;

const RECIPES = Object.freeze({
  codex: Object.freeze({ packageName: "@openai/codex", loginArgs: ["login"] }),
  claude: Object.freeze({ packageName: "@anthropic-ai/claude-code", loginArgs: ["auth", "login"] }),
  kimi: Object.freeze({ packageName: "@moonshot-ai/kimi-code", loginArgs: ["login"] }),
  antigravity: Object.freeze({
    installUrl: "https://antigravity.google/cli/install.sh",
    updateArgs: ["update"],
    loginArgs: ["models"],
  }),
  grok: Object.freeze({ packageName: "@xai-official/grok", loginArgs: ["login"] }),
});

export class AiEnvironmentValidationError extends Error {}
export class AiEnvironmentConflictError extends Error {}
export class AiEnvironmentUnavailableError extends Error {}

function publicJob(job) {
  return {
    id: job.id,
    provider: job.provider,
    action: job.action,
    status: job.status,
    message: job.message,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

async function defaultRunCommand(executable, args, options = {}) {
  return execFileAsync(executable, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 128 * 1024,
    shell: false,
    timeout: ACTION_TIMEOUT_MS,
    signal: options.signal,
    windowsHide: true,
  });
}

async function downloadOfficialScript(url, targetPath, fetchImpl) {
  const response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new AiEnvironmentUnavailableError("官方安装程序暂时无法下载");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SCRIPT_BYTES) {
    throw new AiEnvironmentUnavailableError("官方安装程序大小异常");
  }
  const text = bytes.toString("utf8");
  if (!text.startsWith("#!") || text.includes("\0")) throw new AiEnvironmentUnavailableError("官方安装程序格式异常");
  await fs.writeFile(targetPath, bytes, { mode: 0o700, flag: "wx" });
}

export function createAiEnvironmentActionService(options = {}) {
  const platform = options.platform ?? process.platform;
  const now = options.now ?? (() => new Date());
  const catalogService = options.catalogService ?? createAgentCatalogService(options.catalogOptions);
  const runCommand = options.runCommand ?? defaultRunCommand;
  const resolveCommand = options.resolveExecutable ?? resolveExecutable;
  const fetchImpl = options.fetch ?? fetch;
  const jobs = new Map();
  let activeJobId = null;
  let activeController = null;
  let closed = false;

  function timestamp() { return now().toISOString(); }
  function get(jobId) {
    if (!JOB_ID_RE.test(jobId)) throw new AiEnvironmentValidationError("环境任务 id 无效");
    const job = jobs.get(jobId);
    if (!job) throw new AiEnvironmentValidationError("环境任务不存在");
    return publicJob(job);
  }
  function mutate(job, status, message) {
    job.status = status;
    job.message = message;
    job.updatedAt = timestamp();
  }

  async function npmInstall(recipe, controller) {
    const npmPath = await resolveCommand("npm", {
      env: process.env,
      additionalDirectories: [path.dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin"],
    });
    if (!npmPath) throw new AiEnvironmentUnavailableError("未找到 npm，无法完成安装");
    await runCommand(npmPath, ["install", "-g", `${recipe.packageName}@latest`], {
      env: createMinimalRuntimeEnvironment(process.env),
      signal: controller.signal,
    });
  }

  function npmPrefixForInstalledPackage(agent, recipe) {
    if (!agent.executablePath || !path.isAbsolute(agent.executablePath) || !recipe.packageName) return null;
    const packagePath = recipe.packageName.split("/").join(path.sep);
    const marker = `${path.sep}lib${path.sep}node_modules${path.sep}${packagePath}${path.sep}`;
    const markerIndex = agent.executablePath.indexOf(marker);
    if (markerIndex <= 0) return null;
    const prefix = agent.executablePath.slice(0, markerIndex);
    return path.isAbsolute(prefix) && prefix !== path.parse(prefix).root ? prefix : null;
  }

  async function npmUpdate(agent, recipe, controller) {
    const prefix = npmPrefixForInstalledPackage(agent, recipe);
    if (!prefix) {
      throw new AiEnvironmentUnavailableError("无法确认当前 AI 的 npm 安装目录，请使用官方方式更新");
    }
    const npmPath = await resolveCommand("npm", {
      env: process.env,
      additionalDirectories: [path.join(prefix, "bin"), path.dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin"],
    });
    if (!npmPath) throw new AiEnvironmentUnavailableError("未找到 npm，无法完成更新");
    await runCommand(npmPath, ["install", "--global", "--prefix", prefix, `${recipe.packageName}@latest`], {
      env: createMinimalRuntimeEnvironment(process.env),
      signal: controller.signal,
    });
  }

  async function antigravityInstall(recipe, controller) {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "creator-ai-install-"));
    const scriptPath = path.join(tempRoot, "install.sh");
    try {
      await downloadOfficialScript(recipe.installUrl, scriptPath, fetchImpl);
      await runCommand("/bin/bash", [scriptPath], {
        env: createMinimalRuntimeEnvironment(process.env),
        signal: controller.signal,
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function antigravityUpdate(agent, recipe, controller) {
    if (!agent.executablePath || !path.isAbsolute(agent.executablePath)) {
      throw new AiEnvironmentUnavailableError("Antigravity CLI 路径无效");
    }
    await runCommand(agent.executablePath, recipe.updateArgs, {
      env: createMinimalRuntimeEnvironment(process.env),
      signal: controller.signal,
    });
  }

  async function openLoginTerminal(agent, recipe, job) {
    if (!agent.executablePath || !path.isAbsolute(agent.executablePath)) throw new AiEnvironmentUnavailableError("AI CLI 路径无效");
    const scriptsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "creator-ai-login-"));
    const scriptPath = path.join(scriptsRoot, `${job.id}.command`);
    const command = [shellQuote(agent.executablePath), ...recipe.loginArgs.map(shellQuote)].join(" ");
    const script = `#!/bin/zsh\ntrap 'rm -f -- "$0"; rmdir -- ${shellQuote(scriptsRoot)} 2>/dev/null' EXIT\n${command}\nprintf '\\n登录完成后可以关闭此窗口。\\n'\n`;
    await fs.writeFile(scriptPath, script, { mode: 0o700, flag: "wx" });
    try {
      await runCommand("/usr/bin/open", ["-a", "Terminal", scriptPath], {
        env: createMinimalRuntimeEnvironment(process.env),
      });
    } catch (error) {
      await fs.rm(scriptsRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async function execute(job) {
    const controller = new AbortController();
    activeController = controller;
    mutate(job, "running", job.action === "login" ? "正在打开登录窗口" : "正在处理");
    try {
      const catalog = await catalogService.list();
      const agent = catalog.agents.find((candidate) => candidate.id === job.provider);
      const recipe = RECIPES[job.provider];
      if (!agent || !recipe) throw new AiEnvironmentValidationError("AI Provider 不受支持");
      if (options.isProviderActive?.(job.provider)) throw new AiEnvironmentConflictError("这个 AI 正在会话中，请先结束会话再更新");
      if (job.action === "install" && agent.installed) throw new AiEnvironmentConflictError("这个 AI 已经安装，请使用更新");
      if (job.action !== "install" && !agent.installed) throw new AiEnvironmentConflictError("请先安装这个 AI");
      if (job.action === "update" && agent.versionStatus !== "outdated") throw new AiEnvironmentConflictError("这个 AI 已经是当前版本");
      if (job.action === "login" && agent.authStatus !== "login_required") throw new AiEnvironmentConflictError("这个 AI 当前不需要重新登录");

      if (job.action === "login") {
        await openLoginTerminal(agent, recipe, job);
        mutate(job, "terminal_opened", "登录窗口已打开；完成后重新检测即可");
        return;
      }
      if (job.action === "install") {
        if (recipe.packageName) await npmInstall(recipe, controller);
        else await antigravityInstall(recipe, controller);
      } else if (recipe.packageName) {
        await npmUpdate(agent, recipe, controller);
      } else {
        await antigravityUpdate(agent, recipe, controller);
      }
      const refreshedCatalog = await catalogService.list({ refresh: true });
      const refreshedAgent = refreshedCatalog.agents.find((candidate) => candidate.id === job.provider);
      if (!refreshedAgent?.installed || refreshedAgent.status === "missing") {
        throw new AiEnvironmentUnavailableError("安装程序已经结束，但仍未检测到这个 AI CLI");
      }
      if (job.action === "update" && refreshedAgent.versionStatus === "outdated" && refreshedAgent.version === agent.version) {
        throw new AiEnvironmentUnavailableError("更新程序已经结束，但本机版本没有变化");
      }
      mutate(job, "completed", job.action === "install" ? "安装完成" : "更新完成");
    } catch (error) {
      const message = error instanceof AiEnvironmentConflictError || error instanceof AiEnvironmentValidationError || error instanceof AiEnvironmentUnavailableError
        ? error.message
        : "操作没有完成，请稍后重试";
      mutate(job, "failed", message);
    } finally {
      activeController = null;
      if (activeJobId === job.id) activeJobId = null;
    }
  }

  async function start(input) {
    if (closed) throw new AiEnvironmentUnavailableError("环境服务已经停止");
    if (platform !== "darwin") throw new AiEnvironmentUnavailableError("当前版本只支持 macOS");
    if (!PROVIDERS.has(input?.provider)) throw new AiEnvironmentValidationError("AI Provider 不受支持");
    if (!ACTIONS.has(input?.action)) throw new AiEnvironmentValidationError("环境操作不受支持");
    if (activeJobId) throw new AiEnvironmentConflictError("已有一个环境操作正在进行");
    const createdAt = timestamp();
    const job = {
      id: `ai-env-${crypto.randomUUID()}`,
      provider: input.provider,
      action: input.action,
      status: "queued",
      message: "等待处理",
      createdAt,
      updatedAt: createdAt,
    };
    jobs.set(job.id, job);
    activeJobId = job.id;
    void execute(job);
    return publicJob(job);
  }

  async function close() {
    closed = true;
    activeController?.abort(new DOMException("Service closed", "AbortError"));
  }

  return { start, get, close };
}
