import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const runner = resolve(".github/scripts/run-attachment-replica-e2e.sh");
const knowledgeRunner = resolve(
  ".github/scripts/run-knowledge-provider-e2e.sh",
);

test("platform image reuse checks the registry before starting a builder", () => {
  const result = spawnSync(
    "ruby",
    [
      "-ryaml",
      "-rjson",
      "-e",
      "puts JSON.generate(YAML.load_file(ARGV[0])['jobs']['prepare-platform-e2e-image']['steps'])",
      ".github/workflows/e2e-tests.yml",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const steps = JSON.parse(result.stdout);
  const checkIndex = steps.findIndex((step) => step.id === "image-check");
  const builderIndex = steps.findIndex((step) =>
    step.uses?.startsWith("docker/setup-buildx-action@"),
  );
  const build = steps.find((step) =>
    step.uses?.startsWith("docker/build-push-action@"),
  );
  assert(checkIndex >= 0);
  assert(builderIndex > checkIndex);
  assert.equal(
    steps[builderIndex].if,
    "steps.image-check.outputs.exists != 'true'",
  );
  assert.equal(build.if, steps[builderIndex].if);

  for (const exists of [true, false]) {
    const root = mkdtempSync(join(tmpdir(), "platform-image-check-"));
    try {
      const output = join(root, "output");
      const image = "ghcr.io/example/platform-e2e:content-hash";
      writeFileSync(
        join(root, "docker"),
        `#!${process.execPath}\nconst assert = require('node:assert/strict')\nassert.deepEqual(process.argv.slice(2), ['manifest', 'inspect', process.env.IMAGE])\nprocess.exit(${exists ? 0 : 1})\n`,
      );
      chmodSync(join(root, "docker"), 0o755);
      const probe = spawnSync("bash", ["-e", "-c", steps[checkIndex].run], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          IMAGE: image,
          GITHUB_OUTPUT: output,
        },
      });
      assert.equal(probe.status, 0, probe.stderr);
      assert.equal(readFileSync(output, "utf8"), `exists=${exists}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("dependency caches separate host and container workspace paths", () => {
  const result = spawnSync(
    "ruby",
    [
      "-ryaml",
      "-rjson",
      "-e",
      "puts JSON.generate(YAML.load_file(ARGV[0]))",
      ".github/actions/setup-node-workspace/action.yml",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const steps = JSON.parse(result.stdout).runs.steps;
  const context = steps.find((step) => step.id === "workspace-cache-context");
  const cache = steps.find((step) => step.id === "workspace-cache");
  assert(
    cache.with.key.includes(
      "${{ steps.workspace-cache-context.outputs.fingerprint }}",
    ),
  );
  const root = mkdtempSync(join(tmpdir(), "workspace-cache-context-"));
  try {
    const fingerprint = (cwd) => {
      const output = join(root, "output");
      writeFileSync(output, "");
      const run = spawnSync("bash", ["-eu", "-c", context.run], {
        cwd,
        env: { ...process.env, GITHUB_OUTPUT: output },
        encoding: "utf8",
      });
      assert.equal(run.status, 0, run.stderr);
      const value = readFileSync(output, "utf8").trim();
      assert.match(value, /^fingerprint=[a-f0-9]{64}$/);
      return value;
    };
    const host = fingerprint(root);
    const container = fingerprint(tmpdir());
    assert.notEqual(host, container);
    assert.equal(fingerprint(root), host);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows desktop shards consume packaged dependencies without reinstalling the workspace", () => {
  const result = spawnSync(
    "ruby",
    [
      "-ryaml",
      "-rjson",
      "-e",
      "puts JSON.generate(YAML.load_file(ARGV[0])['jobs']['wework-desktop-windows-core-e2e']['steps'])",
      ".github/workflows/wework-e2e.yml",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const steps = JSON.parse(result.stdout);
  assert(
    !steps.some(
      (step) => step.uses === "./.github/actions/setup-node-workspace",
    ),
  );
  assert(
    steps.some(
      (step) =>
        step.uses?.startsWith("actions/setup-node@") &&
        step.with["node-version"] === "24",
    ),
  );
  const pnpm = steps.find((step) =>
    step.uses?.startsWith("pnpm/action-setup@"),
  );
  assert.equal(
    pnpm.if,
    "contains(matrix.segments, 'workbench-mode') || contains(matrix.segments, 'native-window-startup')",
  );
  assert(
    steps.some(
      (step) =>
        step.name ===
          "Install Electron for native startup and schema verification" &&
        step.if === pnpm.if,
    ),
  );
});

test("platform sharding preserves four runners and every provider shard", () => {
  const result = spawnSync(
    "ruby",
    [
      "-ryaml",
      "-rjson",
      "-e",
      "job = YAML.load_file(ARGV[0])['jobs']['e2e-tests']; puts JSON.generate({matrix: job['strategy']['matrix'], services: job['services'].keys, steps: job['steps']})",
      ".github/workflows/e2e-tests.yml",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const { matrix, services, steps } = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(matrix), ["include"]);
  assert.deepEqual(
    matrix.include.map((row) => row.shardIndex).sort(),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    matrix.include.map((row) => row.providerShardIndex).sort(),
    [1, 2, 3, 4],
  );
  assert(matrix.include.every((row) => row.shardTotal === 4));
  assert(!services.includes("milvus"));
  assert(!services.includes("etcd"));
  const knowledgeSteps = steps.filter((step) =>
    step.run?.includes("run-knowledge-provider-e2e.sh"),
  );
  assert.equal(knowledgeSteps.length, 1);
  assert.equal(knowledgeSteps[0].if, "matrix.shardIndex == 4");
  assert.equal(knowledgeSteps[0]["working-directory"], "./backend");
});

for (const [mode, expectedStatus, expectedTests] of [
  ["success", 0, 2],
  ["dependency-delayed", 0, 2],
  ["test-failure", 37, 2],
  ["process-exited", 1, 0],
  ["startup-budget", 1, 0],
]) {
  test(`knowledge lifecycle preserves readiness and evidence after ${mode}`, () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-lifecycle-"));
    try {
      const log = join(root, "calls.jsonl");
      const evidence = join(root, "evidence");
      const stub = `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const command = path.basename(process.argv[1])
const args = process.argv.slice(2)
const calls = fs.existsSync(process.env.CALL_LOG) ? fs.readFileSync(process.env.CALL_LOG, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse) : []
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ command, args }) + '\\n')
if (command === 'docker' && args[0] === 'inspect') {
  if (args[2] === '{{.State.Status}}') console.log(process.env.TEST_MODE === 'process-exited' && args.at(-1).startsWith('knowledge-milvus-') ? 'exited' : 'running')
  else if (args[2].includes('Healthcheck')) console.log(JSON.stringify({ Test: ['CMD-SHELL', 'curl'] }))
  else console.log(JSON.stringify({ ExitCode: process.env.TEST_MODE === 'process-exited' ? 137 : 0, Health: { Log: ['probe evidence'] } }))
}
if (command === 'curl') {
  const url = args.at(-1)
  if (process.env.TEST_MODE === 'startup-budget' && url.includes('milvus')) process.exit(22)
  if (process.env.TEST_MODE === 'dependency-delayed' && url.includes('etcd') && !calls.some(call => call.command === 'curl' && call.args.at(-1) === url)) process.exit(22)
}
if (command === 'uv' && process.env.TEST_MODE === 'test-failure' && args.at(-1).includes('knowledge_milvus')) process.exit(37)
`;
      for (const name of ["docker", "curl", "uv"]) {
        writeFileSync(join(root, name), stub);
        chmodSync(join(root, name), 0o755);
      }
      const result = spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          'sleep() { if [[ "$TEST_MODE" == startup-budget ]]; then SECONDS=$((SECONDS + 180)); fi; }; source "$1"',
          "knowledge-test",
          knowledgeRunner,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            BASH_ENV: "",
            PATH: `${root}:${process.env.PATH}`,
            CALL_LOG: log,
            TEST_MODE: mode,
            E2E_DOCKER_NETWORK: "existing-platform-network",
            E2E_REPORT_DIR: evidence,
            GITHUB_RUN_ID: "123",
            GITHUB_RUN_ATTEMPT: "1",
          },
        },
      );
      assert.equal(result.status, expectedStatus, result.stderr);
      const calls = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      const tests = calls.filter((call) => call.command === "uv");
      assert.equal(tests.length, expectedTests);
      const starts = calls.filter(
        (call) => call.command === "docker" && call.args[0] === "run",
      );
      assert.equal(starts.length, 2);
      assert(starts[0].args.includes("gcr.io/etcd-development/etcd:v3.5.16"));
      assert(
        starts.every(
          (call) =>
            call.args[call.args.indexOf("--network") + 1] ===
            "existing-platform-network",
        ),
      );
      if (expectedTests) {
        assert.deepEqual(
          tests.map((call) => call.args.at(-1)),
          [
            "tests/e2e/knowledge_remote_index.py",
            "tests/e2e/knowledge_milvus_e2e.py",
          ],
        );
      }
      const milvusStart = calls.findIndex(
        (call) =>
          call.command === "docker" &&
          call.args[0] === "run" &&
          call.args.includes("milvusdb/milvus:v2.5.4"),
      );
      assert(
        calls
          .slice(0, milvusStart)
          .some(
            (call) =>
              call.command === "curl" && call.args.at(-1).includes("etcd"),
          ),
      );
      assert(
        calls
          .slice(0, milvusStart)
          .some(
            (call) =>
              call.command === "curl" && call.args.at(-1).includes("minio"),
          ),
      );
      if (mode === "dependency-delayed") {
        assert.equal(
          calls
            .slice(0, milvusStart)
            .filter(
              (call) =>
                call.command === "curl" && call.args.at(-1).includes("etcd"),
            ).length,
          2,
        );
      }
      const probes = calls.filter(
        (call) =>
          call.command === "curl" && call.args.at(-1).includes("milvus"),
      );
      if (mode === "startup-budget") assert.equal(probes.length, 1);
      if (mode === "process-exited") assert.equal(probes.length, 0);
      for (const container of [
        "knowledge-etcd-123-1",
        "knowledge-milvus-123-1",
      ]) {
        assert(
          calls.some(
            (call) => call.args[0] === "rm" && call.args.includes(container),
          ),
        );
        const state = JSON.parse(
          readFileSync(join(evidence, `${container}-state.json`), "utf8"),
        );
        assert.equal(state.ExitCode, mode === "process-exited" ? 137 : 0);
        assert.deepEqual(state.Health.Log, ["probe evidence"]);
        const healthcheck = JSON.parse(
          readFileSync(join(evidence, `${container}-healthcheck.json`), "utf8"),
        );
        assert.deepEqual(healthcheck.Test, ["CMD-SHELL", "curl"]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const [segments, failFirst] of [
  ["plugin-lifecycle,plugin-composer-network-isolation", false],
  ["plugin-lifecycle,plugin-composer-network-isolation", true],
  ["", false],
]) {
  test(`plugin batch preserves selected scenarios (${segments || "all"}, failure=${failFirst})`, () => {
    const root = mkdtempSync(join(tmpdir(), "e2e-plugin-batch-"));
    try {
      const workflow = readFileSync(".github/workflows/wework-e2e.yml", "utf8");
      const step = workflow.split(
        "      - name: Run Wework desktop ${{ matrix.name }} E2E\n",
      )[1];
      const script = step
        .split("        run: |\n")[1]
        .split("\n      - name:")[0]
        .split("\n")
        .map((line) => line.slice(10))
        .join("\n");
      const log = join(root, "segments");
      const executable = join(root, "xvfb-run");
      writeFileSync(
        executable,
        `#!/bin/bash
printf '%s\\n' "\${@: -1}" >> "$SEGMENT_LOG"
if [[ "$FAIL_FIRST" == true && "\${@: -1}" == plugin-lifecycle ]]; then exit 37; fi
`,
      );
      chmodSync(executable, 0o755);
      const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          SEGMENT_LOG: log,
          FAIL_FIRST: String(failFirst),
          CODEX_BIN: executable,
          WEWORK_E2E_APP_BIN: executable,
          WEWORK_E2E_EXECUTOR_BIN: executable,
          WEWORK_E2E_BACKEND_RS_BIN: executable,
          E2E_COMMAND: "e2e:desktop:plugins",
          E2E_SEGMENT: segments,
        },
      });
      assert.equal(result.status, failFirst ? 37 : 0, result.stderr);
      assert.deepEqual(
        readFileSync(log, "utf8").trim().split("\n"),
        segments ? segments.split(",") : ["e2e:desktop:plugins"],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const [mode, expectedStatus, expectedTests] of [
  ["success", 0, 1],
  ["test-failure", 37, 1],
  ["startup-failure", 1, 0],
  ["temporary-socket-server", 0, 1],
]) {
  test(`replica resources are released after ${mode}`, () => {
    const root = mkdtempSync(join(tmpdir(), "e2e-resource-reuse-"));
    try {
      const log = join(root, "calls.jsonl");
      const stub = `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const command = path.basename(process.argv[1])
const args = process.argv.slice(2)
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ command, args }) + '\\n')
if (command === 'docker' && args[0] === 'inspect') {
  let health = process.env.TEST_MODE === 'startup-failure' ? 'exited unhealthy' : 'running healthy'
  if (process.env.TEST_MODE === 'temporary-socket-server' && args.at(-1).startsWith('attachment-replica-')) {
    const calls = fs.readFileSync(process.env.CALL_LOG, 'utf8').trim().split('\\n').map(JSON.parse)
    const start = calls.find(call => call.command === 'docker' && call.args.includes('mysql:8.0'))
    const probe = start.args.find(arg => arg.startsWith('--health-cmd='))
    const checks = calls.filter(call => call.args[0] === 'inspect' && call.args.at(-1).startsWith('attachment-replica-')).length
    // The entrypoint's temporary server accepts sockets but has no TCP listener.
    if (checks === 1 && probe.includes('--protocol=TCP')) health = 'running starting'
  }
  console.log(health)
}
if (command === 'uv' && process.env.TEST_MODE === 'test-failure') process.exit(37)
if (command === 'uv' && process.env.TEST_MODE === 'temporary-socket-server') {
  const calls = fs.readFileSync(process.env.CALL_LOG, 'utf8').trim().split('\\n').map(JSON.parse)
  const checks = calls.filter(call => call.args[0] === 'inspect' && call.args.at(-1).startsWith('attachment-replica-')).length
  if (checks < 2) process.exit(42)
}
`;
      for (const name of ["docker", "uv"]) {
        writeFileSync(join(root, name), stub);
        chmodSync(join(root, name), 0o755);
      }
      const result = spawnSync("bash", [runner], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          CALL_LOG: log,
          TEST_MODE: mode,
          E2E_DOCKER_NETWORK: "existing-platform-network",
          E2E_REPORT_DIR: join(root, "evidence"),
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "1",
        },
      });
      assert.equal(result.status, expectedStatus, result.stderr);
      const calls = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      const starts = calls.filter(
        (call) => call.command === "docker" && call.args[0] === "run",
      );
      assert.equal(starts.length, 2);
      for (const call of starts) {
        assert.equal(
          call.args[call.args.indexOf("--network") + 1],
          "existing-platform-network",
        );
        const container = call.args[call.args.indexOf("--name") + 1];
        assert(
          calls.some(
            (call) => call.args[0] === "logs" && call.args[1] === container,
          ),
        );
        assert(
          calls.some(
            (call) => call.args[0] === "rm" && call.args.includes(container),
          ),
        );
      }
      const tests = calls.filter((call) => call.command === "uv");
      assert.equal(tests.length, expectedTests);
      if (expectedTests) {
        assert.deepEqual(tests[0].args, [
          "run",
          "--no-sync",
          "python",
          "tests/e2e/attachment_upload_replica.py",
        ]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
