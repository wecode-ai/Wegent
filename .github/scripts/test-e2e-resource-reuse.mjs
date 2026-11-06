import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { runtimeArtifact } from "./runtime-artifact.mjs";
import { containerIPv4, runnerLoopbackHosts } from "./e2e-runner-network.mjs";

test("isolated browsers route localhost to real runner services without retaining a loopback alias", () => {
  const hosts = [
    "127.0.0.1 localhost # IPv4 loopback",
    "::1 localhost ip6-localhost ip6-loopback",
    "172.17.0.1 wegent-e2e-runner",
    "172.17.0.2 browser-container",
    "# localhost in a comment is unchanged",
    "",
  ].join("\n");
  const mapped = runnerLoopbackHosts(hosts, "172.17.0.1");
  assert.equal(
    mapped,
    [
      "# IPv4 loopback",
      "::1\tip6-localhost\tip6-loopback",
      "172.17.0.1 wegent-e2e-runner",
      "172.17.0.2 browser-container",
      "# localhost in a comment is unchanged",
      "172.17.0.1\tlocalhost",
      "",
    ].join("\n"),
  );
  assert.equal(runnerLoopbackHosts(mapped, "172.17.0.1"), mapped);
});

test("invalid runner addresses fail before configuring browser routing", () => {
  for (const gateway of [
    "",
    "localhost",
    "127.0.0.1:8000",
    "::1",
    "1.2.3.4, MAP * 1.2.3.4",
  ]) {
    assert.throws(
      () => runnerLoopbackHosts("127.0.0.1 localhost\n", gateway),
      /IPv4 address/,
    );
  }
});

test("fixture servers advertise the container address reachable from runner processes", () => {
  const interfaces = {
    lo: [
      { address: "127.0.0.1", family: "IPv4", internal: true },
      { address: "::1", family: "IPv6", internal: true },
    ],
    eth0: [
      { address: "fe80::1", family: "IPv6", internal: false },
      { address: "172.17.0.2", family: "IPv4", internal: false },
    ],
  };
  assert.equal(containerIPv4(interfaces), "172.17.0.2");
  assert.throws(
    () => containerIPv4({ lo: interfaces.lo }),
    /no non-loopback IPv4 address/,
  );
  const wrapper = readFileSync(
    ".github/scripts/run-isolated-e2e-browser.sh",
    "utf8",
  );
  assert.match(wrapper, /E2E_TEST_CONTAINER_ADDRESS="\$container_address"/);
  const fixture = readFileSync(
    "frontend/e2e/utils/device-git-http-fixture.ts",
    "utf8",
  );
  assert.match(fixture, /process\.env\.E2E_TEST_CONTAINER_ADDRESS/);
  const artifactFixture = readFileSync(
    "frontend/e2e/utils/artifact-device-fixture.ts",
    "utf8",
  );
  assert.ok(
    artifactFixture.indexOf("process.env.E2E_CLAUDE_MODEL_SERVER_URL") <
      artifactFixture.indexOf("process.env.E2E_LOCAL_CLAUDE_MODEL_SERVER_URL"),
    "container-hosted artifact devices must prefer the runner-reachable model URL",
  );
});

test("executor browser containers isolate network changes while retaining the existing jobs and workers", () => {
  const parsed = spawnSync(
    "ruby",
    [
      "-ryaml",
      "-rjson",
      "-e",
      "puts JSON.generate(YAML.load_file(ARGV[0])['jobs']['executor-e2e-tests'])",
      ".github/workflows/e2e-tests.yml",
    ],
    { encoding: "utf8" },
  );
  assert.equal(parsed.status, 0, parsed.stderr);
  const job = JSON.parse(parsed.stdout);
  for (const name of [
    "Run Executor E2E tests",
    "Run stalled Chat SSE regression",
  ]) {
    const run = job.steps.find((step) => step.name === name).run;
    assert.match(run, /--network bridge\s/);
    assert.match(run, /--add-host wegent-e2e-runner:host-gateway\s/);
    assert.match(
      run,
      /--entrypoint "\$container_workspace\/\.github\/scripts\/run-isolated-e2e-browser\.sh"/,
    );
    assert.doesNotMatch(run, /--network host|--workers|--retries/);
  }
  const wrapper = readFileSync(
    ".github/scripts/run-isolated-e2e-browser.sh",
    "utf8",
  );
  assert.match(wrapper, /export E2E_BROWSER_HOST_GATEWAY=/);
  assert.match(wrapper, /exec "\$@"/);
  const config = readFileSync("frontend/playwright.config.ts", "utf8");
  assert.match(
    config,
    /--host-resolver-rules=MAP localhost \$\{process.env.E2E_BROWSER_HOST_GATEWAY\}/,
  );
  assert.match(config, /name: 'executor-chromium',[\s\S]*?workers: 2/);
});

const runner = resolve(".github/scripts/run-attachment-replica-e2e.sh");
const knowledgeRunner = resolve(
  ".github/scripts/run-knowledge-provider-e2e.sh",
);

test("Executor preparation overlaps the frontend build but consumes only a verified successful producer", () => {
  const parsed = spawnSync(
    "ruby",
    [
      "-ryaml",
      "-rjson",
      "-e",
      "puts JSON.generate(YAML.load_file(ARGV[0])['jobs'])",
      ".github/workflows/e2e-tests.yml",
    ],
    { encoding: "utf8" },
  );
  assert.equal(parsed.status, 0, parsed.stderr);
  const jobs = JSON.parse(parsed.stdout);
  const executor = jobs["executor-e2e-tests"];
  assert.deepEqual(executor.needs, [
    "build-backend-rs-e2e-runtime",
    "build-executor-e2e-runtime",
    "prepare-platform-e2e-image",
  ]);
  assert.equal(executor["runs-on"], "ubuntu-latest");
  assert.equal(executor["timeout-minutes"], 35);
  assert.deepEqual(executor.permissions, {
    actions: "read",
    contents: "read",
    packages: "read",
  });
  assert.deepEqual(Object.keys(executor.services), ["mysql", "redis", "minio"]);
  const steps = executor.steps.map((step) => step.name);
  const download = executor.steps[steps.indexOf("Download frontend E2E build")];
  assert.equal(
    download.env.ACTIONS_ARTIFACT_JOB,
    "Build Frontend E2E Artifact",
  );
  assert.equal(
    download.env.ACTIONS_ARTIFACT_HEAD_SHA,
    "${{ github.event.pull_request.head.sha || github.sha }}",
  );
  assert.equal(
    Number(download.env.ACTIONS_ARTIFACT_WAIT_SECONDS),
    jobs["build-frontend-e2e"]["timeout-minutes"] * 60,
  );
  for (const name of [
    "Restore frontend E2E build",
    "Start frontend server",
    "Run Executor E2E tests",
  ]) {
    assert(steps.indexOf(name) > steps.indexOf(download.name), name);
  }
  assert(jobs["platform-e2e-summary"].needs.includes("build-frontend-e2e"));
});

test("Backend deduplication requires a successful same-head guard and appends its coverage", () => {
  const parsed = spawnSync(
    "ruby",
    [
      "-ryaml",
      "-rjson",
      "-e",
      "puts JSON.generate(YAML.load_file(ARGV[0])['jobs']['test-backend'])",
      ".github/workflows/test.yml",
    ],
    { encoding: "utf8" },
  );
  assert.equal(parsed.status, 0, parsed.stderr);
  const job = JSON.parse(parsed.stdout);
  const guard = job.steps.find(
    (step) =>
      step.name === "Guard approved collaboration permission invariants",
  );
  const full = job.steps.find((step) => step.name === "Run backend tests");
  const files = job.env.BACKEND_GUARD_TESTS.trim().split(/\s+/);
  assert.deepEqual(files, [
    "tests/test_collaboration_permission_guard.py",
    "tests/api/test_collaboration_permission_contract.py",
    "tests/api/test_collaboration_permission_resources.py",
    "tests/api/test_loop_item_reorder_permissions.py",
    "tests/api/test_workspace_shared_agents.py",
    "tests/models/test_collaboration_permission_compatibility.py",
    "tests/test_startup_migration_failure.py",
    "tests/services/test_runner_routing.py",
  ]);
  const directory = mkdtempSync(join(tmpdir(), "backend-test-dedup-"));
  try {
    const backend = join(directory, "backend");
    const bin = join(directory, "bin");
    mkdirSync(backend);
    mkdirSync(bin);
    const uv = join(bin, "uv");
    writeFileSync(
      uv,
      `#!/usr/bin/env node
const fs = require('node:fs')
fs.appendFileSync(process.env.TEST_UV_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
if (process.env.TEST_UV_FAIL === 'true') process.exit(1)
fs.writeFileSync('.coverage', 'guard coverage')
`,
    );
    const git = join(bin, "git");
    writeFileSync(
      git,
      '#!/usr/bin/env bash\ntest "$*" = "rev-parse HEAD"\nprintf "%s\\n" "$TEST_HEAD"\n',
    );
    chmodSync(uv, 0o755);
    chmodSync(git, 0o755);
    const log = join(directory, "uv.log");
    const run = (step, extra = {}) =>
      spawnSync("bash", ["-c", step.run], {
        cwd: backend,
        encoding: "utf8",
        env: {
          ...process.env,
          ...job.env,
          PATH: `${bin}:${process.env.PATH}`,
          TEST_UV_LOG: log,
          TEST_HEAD: "a".repeat(40),
          ...extra,
        },
      });
    assert.notEqual(run(full).status, 0);
    assert.notEqual(run(guard, { TEST_UV_FAIL: "true" }).status, 0);
    assert.notEqual(run(full).status, 0);
    const guarded = run(guard);
    assert.equal(guarded.status, 0, guarded.stderr);
    assert.notEqual(run(full, { TEST_HEAD: "b".repeat(40) }).status, 0);
    const completed = run(full);
    assert.equal(completed.status, 0, completed.stderr);
    const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[1].slice(2, 2 + files.length), files);
    assert.deepEqual(calls[1].slice(2 + files.length, 4 + files.length), [
      "-n",
      "0",
    ]);
    assert(calls[1].includes("--cov=app"));
    assert(calls[2].includes("--cov-append"));
    assert.deepEqual(
      calls[2].filter((arg) => arg.startsWith("--ignore=")),
      files.map((file) => `--ignore=${file}`),
    );
    assert.equal(calls[2].includes("-n"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the existing macOS runner exports verified runtimes after its real checkpoints", () => {
  const parsed = spawnSync(
    "ruby",
    [
      "-ryaml",
      "-rjson",
      "-e",
      "puts JSON.generate(YAML.load_file(ARGV[0])['jobs']['wework-desktop-memory-e2e'])",
      ".github/workflows/wework-e2e.yml",
    ],
    { encoding: "utf8" },
  );
  assert.equal(parsed.status, 0, parsed.stderr);
  const job = JSON.parse(parsed.stdout);
  assert.equal(job["runs-on"], "macos-15");
  const describe = job.steps.find(
    (step) => step.name === "Describe verified native macOS runtimes",
  );
  assert(describe);
  assert.equal(describe.if, undefined);
  assert.equal(describe["continue-on-error"], undefined);
  assert.equal(describe.env.RUNTIME_TARGET, "darwin-arm64");
  assert.equal(
    describe.env.RUNTIME_HEAD_SHA,
    "${{ github.event.pull_request.head.sha || github.sha }}",
  );
  for (const name of [
    "Run Wework desktop memory E2E",
    "Run Wework desktop macOS Inspector E2E",
  ])
    assert(
      job.steps.findIndex((step) => step.name === name) <
        job.steps.indexOf(describe),
    );
  for (const [name, artifact, component] of [
    [
      "Upload verified macOS Executor runtime",
      "macos-executor-e2e-binary",
      "executor",
    ],
    [
      "Upload verified macOS Backend runtime",
      "macos-backend-rs-e2e-runtime",
      "backend-rs",
    ],
  ]) {
    const upload = job.steps.find((step) => step.name === name);
    assert(job.steps.indexOf(upload) > job.steps.indexOf(describe));
    assert.equal(upload.if, undefined);
    assert.equal(upload["continue-on-error"], undefined);
    assert.equal(upload.with.name, artifact);
    assert.equal(upload.with["if-no-files-found"], "error");
    assert.equal(upload.with["retention-days"], 1);
    assert.deepEqual(upload.with.path.trim().split("\n"), [
      `\${{ runner.temp }}/macos-runtimes/${component}/wegent-${component}`,
      `\${{ runner.temp }}/macos-runtimes/${component}/${component}-runtime-manifest.json`,
    ]);
  }
  const directory = mkdtempSync(join(tmpdir(), "macos-runtime-export-"));
  try {
    const executor = join(directory, "executor");
    const backend = join(directory, "backend");
    for (const file of [executor, backend]) {
      writeFileSync(file, "verified runtime bytes");
      chmodSync(file, 0o755);
    }
    const result = spawnSync("bash", ["-e", "-c", describe.run], {
      encoding: "utf8",
      env: {
        ...process.env,
        RUNNER_TEMP: directory,
        GITHUB_REPOSITORY_OWNER: "WECODE-AI",
        RUNTIME_HEAD_SHA: "source-head",
        RUNTIME_TARGET: describe.env.RUNTIME_TARGET,
        WEWORK_E2E_EXECUTOR_BIN: executor,
        WEWORK_E2E_BACKEND_RS_BIN: backend,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    for (const [component, profile] of [
      ["executor", "release"],
      ["backend-rs", "dev"],
    ]) {
      const folder = join(directory, "macos-runtimes", component);
      const manifest = JSON.parse(
        readFileSync(
          join(folder, `${component}-runtime-manifest.json`),
          "utf8",
        ),
      );
      assert.match(
        manifest.sourceRef,
        new RegExp(
          `^ghcr.io/wecode-ai/wegent-wework-macos-e2e-runtime:${component}-v1-[a-f0-9]{64}$`,
        ),
      );
      runtimeArtifact(
        "verify",
        folder,
        component,
        manifest.sourceRef,
        [`wegent-${component}`],
        "source-head",
        "darwin-arm64",
        profile,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

test("platform sharding uses eight runners and preserves every provider shard", () => {
  const result = spawnSync(
    "ruby",
    [
      "-ryaml",
      "-rjson",
      "-e",
      "job = YAML.load_file(ARGV[0])['jobs']['e2e-tests']; puts JSON.generate({matrix: job['strategy']['matrix'], services: job['services'].keys, options: job['container']['options'], steps: job['steps']})",
      ".github/workflows/e2e-tests.yml",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const { matrix, services, options, steps } = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(matrix), ["include"]);
  assert.deepEqual(
    matrix.include.map((row) => row.shardIndex).sort(),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.deepEqual(
    matrix.include.map((row) => row.providerShardIndex).sort(),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert(matrix.include.every((row) => row.shardTotal === 8));
  assert.deepEqual(
    matrix.include
      .filter((row) => row.dingtalkOAuth)
      .map((row) => row.shardIndex),
    [2],
  );
  const preparation = steps.find(
    (step) => step.name === "Prepare isolated DingTalk HTTPS download fixture",
  );
  const oauth = steps.find(
    (step) => step.name === "Run DingTalk document protocol integration tests",
  );
  const report = steps.find(
    (step) => step.name === "Upload DingTalk protocol integration results",
  );
  assert(preparation && oauth && report);
  assert(
    steps.indexOf(preparation) <
      steps.findIndex((step) => step.name === "Start backend server"),
  );
  assert.equal(report.with["if-no-files-found"], "error");
  assert.equal(oauth["timeout-minutes"], 10);
  assert.equal(oauth.id, "dingtalk_oauth_e2e");
  for (const row of matrix.include) {
    const enabled = (expression, outcome = "success") =>
      Boolean(
        runInNewContext(expression, {
          matrix: row,
          steps: { dingtalk_oauth_e2e: { outcome } },
          always: () => true,
        }),
      );
    for (const step of [preparation, oauth])
      assert.equal(enabled(step.if), row.dingtalkOAuth);
    for (const outcome of ["success", "failure", "cancelled", "skipped", ""]) {
      assert.equal(
        enabled(report.if, outcome),
        row.dingtalkOAuth && outcome !== "skipped" && outcome !== "",
      );
    }
    const resolvedOptions = options.replace(
      /\$\{\{\s*(.*?)\s*\}\}/g,
      (_, expression) => runInNewContext(expression, { matrix: row }),
    );
    assert.equal(
      resolvedOptions.includes("--cap-add=NET_ADMIN"),
      row.dingtalkOAuth,
    );
    assert(!resolvedOptions.includes("--privileged"));
  }
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
