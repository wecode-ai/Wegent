import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isolatedGitEnvironment } from "../../wework/scripts/lib/git-environment.mjs";

const runner = fileURLToPath(
  new URL("./run-ai-push-gate.mjs", import.meta.url),
);
const waiting = "[ai-push-gate] Waiting for another worktree to finish checks";

async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), "push-gate-serialization-"));
  const root = join(temporary, "repository");
  const linked = join(temporary, "linked");
  const trace = join(temporary, "trace");
  const release = join(temporary, "release");
  const runs = [];
  const env = {
    ...isolatedGitEnvironment(),
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_AUTHOR_NAME: "Push Gate Test",
    GIT_AUTHOR_EMAIL: "push-gate@example.invalid",
    GIT_COMMITTER_NAME: "Push Gate Test",
    GIT_COMMITTER_EMAIL: "push-gate@example.invalid",
    GATE_TRACE: trace,
    GATE_RELEASE: release,
  };
  t.after(async () => {
    await writeFile(release, "");
    await Promise.all(runs.map((run) => run.finished));
    await rm(temporary, { recursive: true, force: true });
  });
  await mkdir(join(root, "scripts", "hooks"), { recursive: true });
  await writeFile(
    join(root, "scripts", "hooks", "ai-push-gate.sh"),
    `#!/usr/bin/env bash
set -eu
printf 'enter:%s\\n' "$1" >> "$GATE_TRACE"
printf 'gate-entered:%s\\n' "$1"
if [[ "$1" == first ]]; then
  while [[ ! -f "$GATE_RELEASE" ]]; do sleep 0.01; done
fi
printf 'leave:%s\\n' "$1" >> "$GATE_TRACE"
if [[ "$1" == reject ]]; then exit 7; fi
`,
  );
  const git = (args) =>
    execFileSync("git", args, { cwd: root, env, stdio: "pipe" });
  git(["init"]);
  git(["add", "."]);
  git(["commit", "-m", "test: add isolated push gate"]);
  git(["worktree", "add", "--detach", linked]);
  function launch(cwd, name) {
    const events = new EventEmitter();
    const run = { output: "", closed: false, events };
    const child = spawn(process.execPath, [runner, name], { cwd, env });
    child.stdout.on("data", (chunk) => {
      run.output += chunk;
      events.emit("update");
    });
    child.stderr.on("data", (chunk) => {
      run.output += chunk;
    });
    run.finished = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        run.closed = true;
        events.emit("update");
        resolve(code);
      });
    });
    runs.push(run);
    return run;
  }
  return { root, linked, trace, release, launch };
}

function waitForLine(run, accepts) {
  return new Promise((resolve, reject) => {
    const check = () => {
      const line = run.output.split(/\r?\n/).find(accepts);
      if (line || run.closed) {
        run.events.off("update", check);
        if (line) resolve(line);
        else
          reject(
            new Error("Process closed before expected event: " + run.output),
          );
      }
    };
    run.events.on("update", check);
    check();
  });
}

test(
  "serializes linked worktrees while preserving independent repository concurrency",
  { timeout: 30000 },
  async (t) => {
    const shared = await fixture(t);
    const independent = await fixture(t);
    const first = shared.launch(shared.root, "first");
    await waitForLine(first, (line) => line === "gate-entered:first");
    const second = shared.launch(shared.linked, "second");
    const secondState = await waitForLine(
      second,
      (line) => line === waiting || line === "gate-entered:second",
    );
    assert.equal(
      secondState,
      waiting,
      "The second worktree must wait before executing checks",
    );
    const other = independent.launch(independent.root, "other");
    assert.equal(
      await other.finished,
      0,
      "An independent repository must not be blocked",
    );
    assert.equal(second.output.includes("gate-entered:second"), false);
    await writeFile(shared.release, "");
    assert.equal(await first.finished, 0);
    assert.equal(await second.finished, 0);
    assert.equal(
      await readFile(shared.trace, "utf8"),
      "enter:first\nleave:first\nenter:second\nleave:second\n",
    );
  },
);

test(
  "preserves failed check exit status and releases the shared slot",
  { timeout: 30000 },
  async (t) => {
    const shared = await fixture(t);
    assert.equal(await shared.launch(shared.root, "reject").finished, 7);
    assert.equal(
      await shared.launch(shared.linked, "after-failure").finished,
      0,
    );
    assert.equal(
      await readFile(shared.trace, "utf8"),
      "enter:reject\nleave:reject\nenter:after-failure\nleave:after-failure\n",
    );
  },
);
