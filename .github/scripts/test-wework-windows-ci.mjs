import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../workflows/wework-e2e.yml", import.meta.url),
  "utf8",
);
const expression = workflow.match(
  /^      windows_desktop_core_e2e: \$\{\{ (.+) \}\}$/m,
)?.[1];
assert.ok(expression, "Windows scheduling must have a shared output");
const evaluate = new Function(
  "github",
  "steps",
  "contains",
  `return ${expression.replaceAll("labels.*.name", "labels")}`,
);
const steps = { classify: { outputs: { wework_desktop_core_e2e: "true" } } };
for (const [name, eventName, action, labels, draft, label, expected] of [
  [
    "label applied",
    "pull_request",
    "labeled",
    ["ci:all"],
    false,
    "ci:all",
    true,
  ],
  [
    "subsequent push",
    "pull_request",
    "synchronize",
    ["ci:all"],
    false,
    undefined,
    true,
  ],
  [
    "ready for review",
    "pull_request",
    "ready_for_review",
    ["ci:all"],
    false,
    undefined,
    true,
  ],
  [
    "unrelated label",
    "pull_request",
    "labeled",
    ["ci:all", "bug"],
    false,
    "bug",
    false,
  ],
  ["ordinary PR", "pull_request", "synchronize", [], false, undefined, false],
  [
    "draft PR",
    "pull_request",
    "synchronize",
    ["ci:all"],
    true,
    undefined,
    false,
  ],
  ["schedule", "schedule", undefined, [], false, undefined, true],
  ["manual run", "workflow_dispatch", undefined, [], false, undefined, true],
  ["merge queue", "merge_group", undefined, [], false, undefined, false],
]) {
  const github = {
    event_name: eventName,
    event: { action, label: { name: label }, pull_request: { labels, draft } },
  };
  assert.equal(
    evaluate(github, steps, (values, value) => values.includes(value)),
    expected,
    name,
  );
}

const gate = "needs.changes.outputs.windows_desktop_core_e2e == 'true'";
const cloudBlock = workflow
  .split("  wework-desktop-cloud-e2e:\n")[1]
  .split(/\n  [\w-]+:\n/)[0];
assert.match(
  cloudBlock,
  /- name: Set up real object storage for desktop E2E\n\s+uses: \.\/\.github\/actions\/setup-minio-e2e/,
  "Every cloud checkpoint must use real object storage",
);
assert.doesNotMatch(
  cloudBlock,
  /'plugin-(?:catalog|operation)-boundaries'/,
  "Plugin resilience must reuse the existing cloud checkpoint resources",
);
for (const job of [
  "wework-desktop-core-e2e",
  "wework-desktop-windows-core-e2e",
]) {
  const block = workflow.split(`  ${job}:\n`)[1].split(/\n  [\w-]+:\n/)[0];
  const setupName =
    job === "wework-desktop-windows-core-e2e"
      ? "Enable real object storage"
      : "Set up real object storage for desktop E2E";
  const setup = block
    .split(`- name: ${setupName}\n`)[1]
    ?.split(/\n      - name:/)[0];
  assert.ok(setup, `${job} must prepare real object storage`);
  assert.doesNotMatch(
    setup,
    /^\s+if:/m,
    `${job} must prepare real object storage for every checkpoint`,
  );
  if (job === "wework-desktop-windows-core-e2e") {
    assert.match(
      block,
      /Copy-Item -LiteralPath \$source -Destination \$target -Force/,
    );
    assert.match(
      block,
      /Join-Path \$env:GITHUB_WORKSPACE "wework\\test-results\\windows-e2e-tools\\minio"/,
    );
    assert.match(block, /WEWORK_E2E_MINIO_BIN=\$target/);
    assert.doesNotMatch(
      block,
      /uses: \.\/\.github\/actions\/setup-minio-e2e/,
      "A later composite setup must not overwrite the standard user's workspace path",
    );
  } else {
    assert.match(block, /uses: \.\/\.github\/actions\/setup-minio-e2e/);
  }
}
for (const job of [
  "build-wework-desktop-windows-core-e2e",
  "wework-desktop-windows-core-e2e",
]) {
  const block = workflow.split(`  ${job}:\n`)[1].split(/\n  [\w-]+:\n/)[0];
  assert.equal(block.match(/^    if: (.+)$/m)?.[1], gate, job);
}
assert.ok(
  workflow.includes("RUN_WINDOWS_DESKTOP_CORE_E2E: ${{ " + gate + " }}"),
);

const script = execFileSync(
  "ruby",
  [
    "-ryaml",
    "-e",
    `jobs = YAML.safe_load(STDIN.read).fetch("jobs")
     steps = jobs.fetch("wework-e2e-summary").fetch("steps")
     check = steps.find { |step| step["name"] == "Check Wework E2E results" }
     print check.fetch("run")`,
  ],
  { input: workflow, encoding: "utf8" },
);
for (const [buildResult, shardResult, expected] of [
  ["success", "success", 0],
  ["skipped", "success", 1],
  ["success", "skipped", 1],
  ["failure", "success", 1],
  ["success", "failure", 1],
  ["success", "cancelled", 1],
]) {
  const result = spawnSync("bash", ["-c", script], {
    env: {
      ...process.env,
      CHANGES_RESULT: "success",
      RUN_WINDOWS_DESKTOP_CORE_E2E: "true",
      WINDOWS_DESKTOP_CORE_BUILD_RESULT: buildResult,
      WINDOWS_DESKTOP_CORE_E2E_RESULT: shardResult,
    },
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    expected,
    `${buildResult}/${shardResult}: ${result.stdout}${result.stderr}`,
  );
}
assert.ok(
  workflow.includes(
    "node wework/e2e/desktop/run-checkpoints.mjs --memory-only",
  ),
);
const windowsWorker = workflow
  .split("  wework-desktop-windows-core-e2e:\n")[1]
  .split(/\n  [\w-]+:\n/)[0];
const stepBudget = Number(
  windowsWorker.match(
    /name: Run Windows Wework desktop Core shard E2E[\s\S]*?timeout-minutes: (\d+)/,
  )?.[1],
);
const processWrapper = readFileSync(
  new URL("./run-windows-standard-user-process.ps1", import.meta.url),
  "utf8",
);
const processBudget = Number(
  processWrapper.match(/\$remainingSeconds = (\d+) \* 60/)?.[1],
);
assert.ok(
  processBudget > 0 && processBudget < stepBudget,
  "The credentialed process must stop before CI cancellation so evidence can upload",
);
assert.match(
  processWrapper,
  /finally \{[\s\S]*stop-windows-standard-user-processes\.ps1/,
  "Deadline failures must retain the existing SID-scoped cleanup",
);
assert.match(
  workflow.split("  build-wework-desktop-windows-core-e2e:\n")[1],
  /run: \.github\/scripts\/test-windows-standard-user-process\.ps1/,
  "The shared Windows producer must verify the real process deadline contract",
);
console.log("Windows CI event coverage and required-result checks passed");
