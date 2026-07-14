import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultAdapterBinDirectory = path.join(projectRoot, "node_modules", ".bin");

function defaultCliBinDirectories() {
  const home = os.homedir();
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".local", "bin"),
    path.join(home, ".kimi-code", "bin"),
    path.join(home, ".grok", "bin"),
    path.dirname(process.execPath),
  ];
}

export const VERSION_PROBE_TIMEOUT_MS = 3_000;
export const CAPABILITY_PROBE_TIMEOUT_MS = 5_000;
export const AUTH_PROBE_TIMEOUT_MS = 15_000;
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;
const MAX_VERSION_INPUT_BYTES = 16 * 1024;

const AUTH_STATUSES = new Set(["unknown", "ready", "login_required"]);

function freezeProvider(provider) {
  return Object.freeze({
    ...provider,
    versionArgs: Object.freeze([...provider.versionArgs]),
    authArgs: provider.authArgs ? Object.freeze([...provider.authArgs]) : null,
    capabilityArgs: provider.capabilityArgs ? Object.freeze([...provider.capabilityArgs]) : null,
    capabilityMarkers: provider.capabilityMarkers
      ? Object.freeze([...provider.capabilityMarkers])
      : null,
    adapter: provider.adapter
      ? Object.freeze({
        ...provider.adapter,
        capabilityArgs: provider.adapter.capabilityArgs
          ? Object.freeze([...provider.adapter.capabilityArgs])
          : null,
        capabilityMarkers: provider.adapter.capabilityMarkers
          ? Object.freeze([...provider.adapter.capabilityMarkers])
          : null,
      })
      : null,
  });
}

/**
 * This registry is deliberately static. It is product metadata, not an install
 * manifest: catalog probing must never download, install, upgrade, or execute
 * package-manager commands.
 */
export const AI_AGENT_PROVIDERS = Object.freeze([
  freezeProvider({
    id: "codex",
    displayName: "Codex",
    command: "codex",
    versionArgs: ["--version"],
    latestStable: "0.144.4",
    testedVersion: "0.144.1",
    acpMode: "adapter",
    authArgs: ["login", "status"],
    officialSource: "https://help.openai.com/en/articles/11096431",
    adapter: {
      packageName: "@agentclientprotocol/codex-acp",
      command: "codex-acp",
      capabilityArgs: null,
      capabilityMarkers: null,
    },
  }),
  freezeProvider({
    id: "claude",
    displayName: "Claude Code",
    command: "claude",
    versionArgs: ["--version"],
    latestStable: "2.1.208",
    testedVersion: "2.1.207",
    acpMode: "adapter",
    authArgs: ["auth", "status", "--json"],
    officialSource: "https://docs.anthropic.com/en/docs/claude-code/getting-started",
    adapter: {
      packageName: "@agentclientprotocol/claude-agent-acp",
      command: "claude-agent-acp",
      capabilityArgs: null,
      capabilityMarkers: null,
    },
  }),
  freezeProvider({
    id: "kimi",
    displayName: "Kimi Code",
    command: "kimi",
    versionArgs: ["--version"],
    latestStable: "0.23.6",
    testedVersion: "0.20.1",
    acpMode: "native",
    capabilityArgs: ["acp", "--help"],
    capabilityMarkers: ["acp", "agent client protocol", "usage"],
    authArgs: ["doctor"],
    officialSource: "https://moonshotai.github.io/kimi-code/en/guides/getting-started.html",
  }),
  freezeProvider({
    id: "antigravity",
    displayName: "Antigravity",
    command: "agy",
    versionArgs: ["--version"],
    latestStable: "1.1.2",
    testedVersion: "1.0.16",
    acpMode: "conversation_cli",
    authArgs: ["models"],
    officialSource: "https://antigravity.google/docs/cli-reference",
  }),
  freezeProvider({
    id: "grok",
    displayName: "Grok Build",
    command: "grok",
    versionArgs: ["--version"],
    latestStable: "0.2.101",
    testedVersion: "0.2.99",
    acpMode: "native",
    capabilityArgs: ["agent", "--help"],
    capabilityMarkers: ["stdio"],
    authArgs: ["models"],
    officialSource: "https://docs.x.ai/build/overview",
  }),
]);

export class AgentProbeTimeoutError extends Error {}
export class AgentProbeExecutionError extends Error {}

function safeProbeEnvironment(source = process.env) {
  const result = Object.create(null);
  // Provider credentials stay in their own local config files. HOME is needed
  // to locate those files, while raw token/API-key environment variables are
  // deliberately excluded from probes.
  for (const key of [
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "WINDIR",
  ]) {
    if (typeof source[key] === "string") result[key] = source[key];
  }
  return result;
}

export async function defaultRunCommand(executable, args, options) {
  try {
    return await new Promise((resolve, reject) => {
      const child = execFile(executable, args, {
        encoding: "utf8",
        env: options.env,
        maxBuffer: MAX_PROBE_OUTPUT_BYTES,
        shell: false,
        timeout: options.timeout,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
      // Some CLIs wait for EOF before deciding they are non-interactive.
      child.stdin?.end();
    });
  } catch (error) {
    if (error?.killed || error?.code === "ETIMEDOUT" || error?.signal === "SIGTERM") {
      throw new AgentProbeTimeoutError("CLI 探测超时", { cause: error });
    }
    throw new AgentProbeExecutionError("CLI 探测失败", { cause: error });
  }
}

/** Resolve a fixed command name through absolute PATH entries and return its real path. */
export async function resolveExecutable(command, options = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(command)) return null;
  const env = options.env ?? process.env;
  const fileSystem = options.fileSystem ?? fs;
  const pathValue = typeof env.PATH === "string" ? env.PATH : "";
  const seen = new Set();

  const directories = [
    ...(options.additionalDirectories ?? []),
    ...pathValue.split(path.delimiter),
  ];
  for (const directory of directories) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, command);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const real = await fileSystem.realpath(candidate);
      if (!path.isAbsolute(real)) continue;
      const stat = await fileSystem.stat(real);
      if (!stat.isFile()) continue;
      await fileSystem.access(real, fsConstants.X_OK);
      return real;
    } catch {
      // A missing, non-executable, or broken candidate is simply not installed.
    }
  }
  return null;
}

function normalizeProbeText(result) {
  const stdout = typeof result?.stdout === "string" ? result.stdout : "";
  const stderr = typeof result?.stderr === "string" ? result.stderr : "";
  const combined = `${stdout}\n${stderr}`;
  if (Buffer.byteLength(combined, "utf8") > MAX_VERSION_INPUT_BYTES) return null;
  return combined
    .replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim();
}

export function extractSemanticVersion(result) {
  const text = normalizeProbeText(result);
  if (!text) return null;
  const match = text.match(
    /(?:^|[^0-9A-Za-z])v?(\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,31})?)(?=$|[^0-9A-Za-z.-])/,
  );
  return match?.[1] ?? null;
}

function compareVersions(current, latest) {
  if (!current || !latest) return "unknown";
  const parse = (value) => value.split("-")[0].split(".").map((part) => Number(part));
  const left = parse(current);
  const right = parse(latest);
  if (left.some((part) => !Number.isSafeInteger(part)) || right.some((part) => !Number.isSafeInteger(part))) {
    return "unknown";
  }
  for (let index = 0; index < 3; index += 1) {
    if (left[index] < right[index]) return "outdated";
    if (left[index] > right[index]) return "newer";
  }
  return "current";
}

function supportsCapability(result, markers) {
  const text = normalizeProbeText(result);
  if (!text) return false;
  const lower = text.toLowerCase();
  return markers.some((marker) => lower.includes(marker.toLowerCase()));
}

function baseAgent(provider, overrides = {}) {
  const value = {
    id: provider.id,
    displayName: provider.displayName,
    installed: false,
    executablePath: null,
    version: null,
    latestStable: provider.latestStable,
    testedVersion: provider.testedVersion,
    versionStatus: "unknown",
    acpMode: provider.acpMode,
    acpStatus: "unknown",
    status: "missing",
    authStatus: "unknown",
    officialSource: provider.officialSource,
    actions: {
      canInstall: process.platform === "darwin",
      canUpdate: process.platform === "darwin",
      canLogin: process.platform === "darwin",
    },
    ...overrides,
  };
  if (!AUTH_STATUSES.has(value.authStatus)) value.authStatus = "unknown";
  if (provider.adapter) {
    value.adapter = {
      packageName: provider.adapter.packageName,
      command: provider.adapter.command,
      installed: false,
      executablePath: null,
      version: null,
      automaticInstall: false,
      ...(overrides.adapter ?? {}),
    };
  }
  return value;
}

async function readInstalledAdapterVersion(packageName, fileSystem = fs) {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(packageName)) return null;
  const packageJsonPath = path.join(projectRoot, "node_modules", ...packageName.split("/"), "package.json");
  try {
    const raw = await fileSystem.readFile(packageJsonPath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 128 * 1024) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.version === "string" && /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,31})?$/.test(parsed.version)
      ? parsed.version
      : null;
  } catch {
    return null;
  }
}

function timeoutLike(error) {
  return error instanceof AgentProbeTimeoutError
    || error?.name === "AbortError"
    || error?.code === "ETIMEDOUT"
    || error?.killed === true;
}

async function probeProvider(provider, dependencies) {
  let executablePath;
  try {
    executablePath = await dependencies.resolveExecutable(provider.command, {
      env: dependencies.env,
      additionalDirectories: dependencies.cliBinDirectories,
    });
  } catch {
    return baseAgent(provider, { status: "error" });
  }
  if (!executablePath || !path.isAbsolute(executablePath)) return baseAgent(provider);

  let versionResult;
  try {
    versionResult = await dependencies.runCommand(executablePath, provider.versionArgs, {
      env: dependencies.probeEnv,
      maxBuffer: MAX_PROBE_OUTPUT_BYTES,
      shell: false,
      timeout: VERSION_PROBE_TIMEOUT_MS,
    });
  } catch (error) {
    return baseAgent(provider, {
      installed: true,
      executablePath,
      status: timeoutLike(error) ? "timeout" : "error",
    });
  }

  const version = extractSemanticVersion(versionResult);
  const versionFields = {
    installed: true,
    executablePath,
    version,
    versionStatus: compareVersions(version, provider.latestStable),
  };
  if (!version) return baseAgent(provider, { ...versionFields, status: "error" });

  let capabilityExecutable = provider.capabilityArgs && provider.capabilityMarkers ? executablePath : null;
  let capabilityArgs = provider.capabilityArgs;
  let capabilityMarkers = provider.capabilityMarkers;
  let adapterFields;

  if (provider.adapter) {
    let adapterPath;
    try {
      adapterPath = await dependencies.resolveExecutable(provider.adapter.command, {
        env: dependencies.env,
        additionalDirectories: dependencies.adapterBinDirectories,
      });
    } catch {
      return baseAgent(provider, { ...versionFields, status: "error" });
    }
    adapterFields = {
      packageName: provider.adapter.packageName,
      command: provider.adapter.command,
      installed: Boolean(adapterPath && path.isAbsolute(adapterPath)),
      executablePath: adapterPath && path.isAbsolute(adapterPath) ? adapterPath : null,
      version: null,
      automaticInstall: false,
    };
    if (!adapterFields.installed) {
      return baseAgent(provider, {
        ...versionFields,
        status: "adapter_required",
        adapter: adapterFields,
      });
    }
    capabilityExecutable = adapterFields.executablePath;
    adapterFields.version = await readInstalledAdapterVersion(provider.adapter.packageName, dependencies.fileSystem);
    capabilityArgs = provider.adapter.capabilityArgs;
    capabilityMarkers = provider.adapter.capabilityMarkers;
    // The official adapters are stdio servers and deliberately do not expose a
    // help command. Starting one only to parse prose would hang until timeout.
    // Presence is established from the verified local package executable; the
    // real ACP initialize handshake happens when a run starts.
    if (!capabilityArgs || !capabilityMarkers) capabilityExecutable = null;
  }

  let capabilityAvailable = true;
  if (capabilityExecutable) {
    let capabilityResult;
    try {
      capabilityResult = await dependencies.runCommand(capabilityExecutable, capabilityArgs, {
        env: dependencies.probeEnv,
        maxBuffer: MAX_PROBE_OUTPUT_BYTES,
        shell: false,
        timeout: CAPABILITY_PROBE_TIMEOUT_MS,
      });
    } catch (error) {
      return baseAgent(provider, {
        ...versionFields,
        status: timeoutLike(error) ? "timeout" : "error",
        ...(adapterFields ? { adapter: adapterFields } : {}),
      });
    }
    capabilityAvailable = supportsCapability(capabilityResult, capabilityMarkers);
  }

  let authStatus = "unknown";
  if (capabilityAvailable && provider.authArgs) {
    try {
      await dependencies.runCommand(executablePath, provider.authArgs, {
        env: dependencies.probeEnv,
        maxBuffer: MAX_PROBE_OUTPUT_BYTES,
        shell: false,
        timeout: AUTH_PROBE_TIMEOUT_MS,
      });
      authStatus = "ready";
    } catch (error) {
      if (timeoutLike(error)) {
        return baseAgent(provider, {
          ...versionFields,
          status: "timeout",
          ...(adapterFields ? { adapter: adapterFields } : {}),
        });
      }
      authStatus = "login_required";
    }
  }

  return baseAgent(provider, {
    ...versionFields,
    status: capabilityAvailable ? "ready" : "incompatible",
    authStatus,
    acpStatus: capabilityAvailable ? "available" : "unavailable",
    ...(adapterFields ? { adapter: adapterFields } : {}),
  });
}

export function createAgentCatalogService(options = {}) {
  const env = options.env ?? process.env;
  const cacheTtlMs = options.cacheTtlMs ?? 5 * 60_000;
  const now = options.now ?? (() => Date.now());
  const dependencies = {
    env,
    probeEnv: safeProbeEnvironment(env),
    resolveExecutable: options.resolveExecutable ?? resolveExecutable,
    runCommand: options.runCommand ?? defaultRunCommand,
    cliBinDirectories: options.cliBinDirectories ?? defaultCliBinDirectories(),
    adapterBinDirectories: options.adapterBinDirectories ?? [defaultAdapterBinDirectory],
    fileSystem: options.fileSystem ?? fs,
  };

  let cachedCatalog = null;
  let cachedAt = 0;
  let cachedGeneration = 0;
  let nextGeneration = 0;
  let inFlight = null;

  async function probeCatalog() {
    const agents = await Promise.all(
      AI_AGENT_PROVIDERS.map((provider) => probeProvider(provider, dependencies)),
    );
    return {
      agents,
      policy: {
        automaticInstall: false,
        automaticUpgrade: false,
        credentialAccess: false,
        userConfirmedActions: true,
        supportedPlatform: process.platform === "darwin" ? "macos" : "unsupported",
      },
    };
  }

  function startProbe() {
    if (inFlight) return inFlight.promise;
    const generation = ++nextGeneration;
    const promise = probeCatalog()
      .then((catalog) => {
        cachedCatalog = catalog;
        cachedAt = now();
        cachedGeneration = generation;
        return catalog;
      })
      .finally(() => {
        if (inFlight?.generation === generation) inFlight = null;
      });
    inFlight = { generation, promise };
    return promise;
  }

  return {
    async list({ refresh = false } = {}) {
      if (!refresh && cachedCatalog && now() - cachedAt < cacheTtlMs) return cachedCatalog;
      if (!refresh) return startProbe();

      const generationAtRequest = nextGeneration;
      if (inFlight) {
        try {
          await inFlight.promise;
        } catch {
          // A forced refresh is a new authoritative probe even if the older
          // probe failed, so continue below instead of reusing that failure.
        }
      }
      if (nextGeneration > generationAtRequest) {
        if (inFlight) return inFlight.promise;
        if (cachedCatalog && cachedGeneration > generationAtRequest) return cachedCatalog;
      }
      return startProbe();
    },
  };
}
