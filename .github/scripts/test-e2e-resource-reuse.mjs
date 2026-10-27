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

test("platform sharding preserves four runners and every provider shard", () => {
  const result = spawnSync(
    "ruby",
    [
      "-ryaml",
      "-rjson",
      "-e",
      "puts JSON.generate(YAML.load_file(ARGV[0])['jobs']['e2e-tests']['strategy']['matrix'])",
      ".github/workflows/e2e-tests.yml",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const matrix = JSON.parse(result.stdout);
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
});

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
  console.log(process.env.TEST_MODE === 'startup-failure' ? 'exited unhealthy' : 'running healthy')
}
if (command === 'uv' && process.env.TEST_MODE === 'test-failure') process.exit(37)
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
