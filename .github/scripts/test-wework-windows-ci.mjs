import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  /if: contains\(matrix.segments, 'plugin-write-coordination'\)[^\n]*\n\s+uses: \.\/\.github\/actions\/setup-minio-e2e/,
  "Cloud plugin write coordination must use real object storage for sync recovery",
);
assert.match(
  cloudBlock,
  /if: [^\n]*contains\(matrix.segments, 'plugin-operation-boundaries'\)[^\n]*\n\s+uses: \.\/\.github\/actions\/setup-minio-e2e/,
  "Cloud plugin operation boundaries must use real object storage",
);
for (const job of [
  "wework-desktop-core-e2e",
  "wework-desktop-windows-core-e2e",
]) {
  const block = workflow.split(`  ${job}:\n`)[1].split(/\n  [\w-]+:\n/)[0];
  assert.match(
    block,
    /if: .*contains\(matrix.segments, 'collaboration-issue-mcp-comments'\).*contains\(matrix.segments, 'collaboration-delivery-editing'\)/,
    `${job} must prepare real object storage for both collaboration segments`,
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

const summary = workflow
  .split("  wework-e2e-summary:\n")[1]
  .split("  wework-desktop-memory-e2e:")[0];
const script = summary
  .split("        run: |\n")[1]
  .split("\n")
  .map((line) => line.slice(10))
  .join("\n");
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
console.log("Windows CI event coverage and required-result checks passed");
