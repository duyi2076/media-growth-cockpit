import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { createAntigravityConversationRunner } from "../ai-collaboration/antigravity-conversation-runner.mjs";

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

async function fakeAgy() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fake-agy-"));
  roots.push(root);
  const executable = path.join(root, "agy");
  await fs.writeFile(executable, `#!/bin/sh
log=''
session=''
prompt=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --log-file) shift; log="$1" ;;
    --conversation) shift; session="$1" ;;
    --print) shift; prompt="$1" ;;
  esac
  shift
done
id='11111111-1111-4111-8111-111111111111'
printf 'Print mode: starting (conversationID="%s")\n' "$id" >> "$log"
if [ -n "$session" ]; then
  printf '继续会话：%s' "$prompt"
else
  printf '首轮回答：%s' "$prompt"
fi
`, { mode: 0o755 });
  return executable;
}

function options(executable, overrides = {}) {
  return {
    launch: { provider: "antigravity", executable, args: [], env: { PATH: "/usr/bin:/bin", HOME: os.homedir() } },
    cwd: path.dirname(executable),
    permissionMode: "readonly",
    ...overrides,
  };
}

describe("Antigravity conversation runner", () => {
  test("首轮提取会话 id，重建 runner 后用 --conversation 延续同一会话", async () => {
    const executable = await fakeAgy();
    const launches = [];
    let saved = null;
    const first = createAntigravityConversationRunner(options(executable, {
      spawnProcess(command, args, spawnOptions) {
        launches.push({ command, args: [...args], options: spawnOptions });
        return spawn(command, args, spawnOptions);
      },
      onSession(value) { saved = value; },
    }));
    const firstEvents = [];
    const firstResult = await first.prompt({ text: "第一问", onEvent: (event) => firstEvents.push(event) });
    assert.equal(firstResult.finalText, "首轮回答：第一问");
    assert.equal(firstEvents.map((event) => event.text).join(""), firstResult.finalText);
    assert.equal(saved.providerSessionId, "11111111-1111-4111-8111-111111111111");
    assert.equal(saved.transport, "antigravity-cli");
    assert.ok(launches[0].args.includes("--mode"));
    assert.ok(launches[0].args.includes("plan"));
    assert.ok(launches[0].args.includes("--sandbox"));
    assert.equal(launches[0].args.includes("--conversation"), false);
    assert.equal(launches[0].options.shell, false);
    await first.close();

    const second = createAntigravityConversationRunner(options(executable, {
      savedSession: saved,
      spawnProcess(command, args, spawnOptions) {
        launches.push({ command, args: [...args], options: spawnOptions });
        return spawn(command, args, spawnOptions);
      },
    }));
    const secondResult = await second.prompt({ text: "第二问" });
    assert.equal(secondResult.finalText, "继续会话：第二问");
    const marker = launches[1].args.indexOf("--conversation");
    assert.equal(launches[1].args[marker + 1], saved.providerSessionId);
    await second.close();
  });

  test("ask 模式与无效恢复 id 会被安全拦截", async () => {
    const executable = await fakeAgy();
    assert.throws(() => createAntigravityConversationRunner(options(executable, { permissionMode: "ask" })));
    const runner = createAntigravityConversationRunner(options(executable, {
      savedSession: { providerSessionId: "../../bad" },
    }));
    const result = await runner.prompt({ text: "仍从首轮开始" });
    assert.match(result.finalText, /^首轮回答/);
    await runner.close();
  });
});
