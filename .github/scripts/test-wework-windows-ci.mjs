import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const workflow = readFileSync(
  new URL("../workflows/wework-e2e.yml", import.meta.url),
  "utf8",
);
const schedulingExpression = (output) => {
  const expression = workflow.match(
    new RegExp(`^      ${output}: \\$\\{\\{ (.+) \\}\\}$`, "m"),
  )?.[1];
  assert.ok(expression, `${output} must have a shared scheduling output`);
  return new Function(
    "github",
    "steps",
    "contains",
    `return ${expression.replaceAll("labels.*.name", "labels")}`,
  );
};
const evaluateCore = schedulingExpression("windows_desktop_core_e2e");
const evaluateInstaller = schedulingExpression("windows_installer_e2e");
for (const [name, eventName, action, labels, draft, label, core, installer] of [
  [
    "label applied",
    "pull_request",
    "labeled",
    ["ci:all"],
    false,
    "ci:all",
    true,
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
    false,
  ],
  [
    "ordinary PR",
    "pull_request",
    "synchronize",
    [],
    false,
    undefined,
    false,
    true,
  ],
  [
    "unlabeled ready PR",
    "pull_request",
    "ready_for_review",
    [],
    false,
    undefined,
    false,
    true,
  ],
  [
    "draft PR",
    "pull_request",
    "synchronize",
    ["ci:all"],
    true,
    undefined,
    false,
    false,
  ],
  ["schedule", "schedule", undefined, [], false, undefined, true, true],
  [
    "manual run",
    "workflow_dispatch",
    undefined,
    [],
    false,
    undefined,
    true,
    true,
  ],
  ["merge queue", "merge_group", undefined, [], false, undefined, false, false],
]) {
  const github = {
    event_name: eventName,
    event: { action, label: { name: label }, pull_request: { labels, draft } },
  };
  for (const [coreClassified, installerClassified] of [
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ]) {
    const steps = {
      classify: {
        outputs: {
          wework_desktop_core_e2e: String(coreClassified),
          wework_windows_installer_e2e: String(installerClassified),
        },
      },
    };
    const contains = (values, value) => values.includes(value);
    assert.equal(
      evaluateCore(github, steps, contains),
      coreClassified && core,
      `${name}: core`,
    );
    assert.equal(
      evaluateInstaller(github, steps, contains),
      installerClassified && installer,
      `${name}: installer`,
    );
  }
}

for (const [path, expected] of [
  ["wework/electron/electron-builder.config.cjs", true],
  ["wework/electron/package.json", false],
  ["wework/electron/pnpm-lock.yaml", false],
  ["wework/electron/src/build-identity.test.ts", false],
  ["wework/electron/scripts/build-identity.cjs", false],
  ["wework/electron/scripts/verify-windows-migration-lock.cjs", false],
  ["wework/e2e/desktop/windows-installer.e2e.mjs", true],
  ["wework/e2e/desktop/modules/windows-installer-ui.ps1", true],
  [".github/actions/build-wework-windows-e2e/action.yml", false],
  [".github/scripts/run-windows-standard-user-process.ps1", false],
  [".github/scripts/stop-windows-standard-user-processes.ps1", false],
  ["wework/src/App.tsx", false],
  ["docs/zh/index.md", false],
  ["--all", true],
]) {
  const directory = mkdtempSync(
    join(tmpdir(), "windows-installer-classifier-"),
  );
  const output = join(directory, "output");
  try {
    const result = spawnSync(
      "bash",
      [
        fileURLToPath(
          new URL("./classify-wework-desktop-e2e.sh", import.meta.url),
        ),
        path,
      ],
      { env: { ...process.env, GITHUB_OUTPUT: output }, encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${path}: ${result.stderr}`);
    const classified = readFileSync(output, "utf8");
    assert.ok(
      classified.includes(`wework_windows_installer_e2e=${expected}\n`),
      path,
    );
    if (path === "wework/e2e/desktop/modules/windows-installer-ui.ps1") {
      const coreMatrix = classified.match(
        /^wework_desktop_core_e2e_matrix=(.+)$/m,
      )?.[1];
      assert.deepEqual(
        JSON.parse(coreMatrix).include.map((shard) => shard.segments),
        ["release-package-startup"],
        "The Windows installer UI helper must select one packaging checkpoint",
      );
      assert.match(classified, /^wework_desktop_cloud_e2e=false$/m);
      assert.match(classified, /^wework_desktop_other_e2e=false$/m);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const gate = "needs.changes.outputs.windows_desktop_core_e2e == 'true'";
const installerGate = "needs.changes.outputs.windows_installer_e2e == 'true'";
const buildGate = `${gate} || ${installerGate}`;
const installerFallbackGate = `${installerGate} && needs.changes.outputs.windows_desktop_core_e2e != 'true'`;
const cloudBlock = workflow
  .split("  wework-desktop-cloud-e2e:\n")[1]
  .split(/\n  [\w-]+:\n/)[0];
assert.match(
  cloudBlock,
  /if: contains\(matrix.segments, 'plugin-write-coordination'\)[^\n]*\n\s+uses: \.\/\.github\/actions\/setup-minio-e2e/,
  "Cloud plugin write coordination must use real object storage for sync recovery",
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
for (const [job, expectedGate] of [
  ["build-wework-desktop-windows-core-e2e", buildGate],
  ["wework-desktop-windows-core-e2e", gate],
]) {
  const block = workflow.split(`  ${job}:\n`)[1].split(/\n  [\w-]+:\n/)[0];
  assert.equal(block.match(/^    if: (.+)$/m)?.[1], expectedGate, job);
}
const buildBlock = workflow
  .split("  build-wework-desktop-windows-core-e2e:\n")[1]
  .split(/\n  [\w-]+:\n/)[0];
assert.match(buildBlock, /--prepackaged release\/WeWork-win32-x64/);
assert.match(
  buildBlock,
  /--config\.compression=store/,
  "Installer E2E packaging must not pay the release compression cost",
);
assert.match(
  buildBlock,
  /name: Verify alternate-drive installation as a standard user\n        if: [^\n]+\n        shell: pwsh\n        env:\n          WEWORK_E2E_WINDOWS_INSTALLER: [^\n]+\n        run: \|\n          & \.\/\.github\/scripts\/run-windows-standard-user-process\.ps1 `\n            -FilePath \(Get-Command node\)\.Source `\n            -ArgumentList "wework\/e2e\/desktop\/windows-installer\.e2e\.mjs"/,
  "Installer verification must run as a standard user in the shard or installer-only build fallback",
);
assert.ok(
  buildBlock.indexOf("Verify alternate-drive installation") >
    buildBlock.indexOf("Build Windows NSIS installer"),
);
for (const [name, expectedGate] of [
  ["Prepare Windows Redis E2E tools", gate],
  ["Upload Windows Wework desktop Core E2E build", gate],
  ["Upload Windows Redis E2E tools", gate],
  ["Install Windows installer packaging dependencies", installerFallbackGate],
  [
    "Build Windows NSIS installer for alternate-drive E2E",
    installerFallbackGate,
  ],
  [
    "Verify alternate-drive installation as a standard user",
    installerFallbackGate,
  ],
]) {
  const step = buildBlock
    .split(`      - name: ${name}\n`)[1]
    .split("      - name:")[0];
  assert.equal(step.match(/^        if: (.+)$/m)?.[1], expectedGate, name);
}
assert.doesNotMatch(
  workflow,
  /wework-desktop-windows-installer|WINDOWS_DESKTOP_INSTALLER_E2E/,
);
const evidenceStep = buildBlock
  .split("      - name: Upload Windows installer verification evidence\n")[1]
  .split("      - name:")[0];
assert.equal(
  evidenceStep.match(/^        if: (.+)$/m)?.[1],
  `always() && ${installerFallbackGate}`,
);
assert.match(evidenceStep, /windows-installer\/evidence\.json/);
assert.match(evidenceStep, /windows-installer\/app\.log/);
assert.match(evidenceStep, /windows-installer\/ui-helper\.log/);
assert.doesNotMatch(evidenceStep, /release-installer|\.exe/);
const shardBlock = workflow
  .split("  wework-desktop-windows-core-e2e:\n")[1]
  .split(/\n  [\w-]+:\n/)[0];
assert.match(
  shardBlock,
  /name: Verify alternate-drive installation as a standard user\n        if: always\(\) && matrix\.id == 'core-10' && needs\.changes\.outputs\.windows_installer_e2e == 'true'/,
  "Core E2E runs must host installer verification in the balanced core-10 shard",
);
assert.ok(
  shardBlock.indexOf("Verify alternate-drive installation") >
    shardBlock.indexOf("Build Windows NSIS installer"),
);
assert.match(
  buildBlock,
  /!wework\/test-results\/desktop-e2e\/windows-installer\/\*\*/,
);
assert.ok(
  workflow.includes("RUN_WINDOWS_DESKTOP_CORE_E2E: ${{ " + gate + " }}"),
);
assert.ok(
  workflow.includes("RUN_WINDOWS_DESKTOP_BUILD: ${{ " + buildGate + " }}"),
);

const summary = workflow
  .split("  wework-e2e-summary:\n")[1]
  .split("  wework-desktop-memory-e2e:")[0];
const script = summary
  .split("        run: |\n")[1]
  .split("\n")
  .map((line) => line.slice(10))
  .join("\n");
for (const [core, build, buildResult, shardResult, expected] of [
  [true, true, "success", "success", 0],
  [true, true, "skipped", "success", 1],
  [true, true, "success", "skipped", 1],
  [true, true, "failure", "success", 1],
  [true, true, "cancelled", "success", 1],
  [true, true, "success", "failure", 1],
  [true, true, "success", "cancelled", 1],
  [false, true, "success", "skipped", 0],
  [false, true, "skipped", "skipped", 1],
  [false, true, "failure", "skipped", 1],
  [false, true, "cancelled", "skipped", 1],
  [false, false, "skipped", "skipped", 0],
]) {
  const result = spawnSync("bash", ["-c", script], {
    env: {
      ...process.env,
      CHANGES_RESULT: "success",
      RUN_WINDOWS_DESKTOP_CORE_E2E: String(core),
      RUN_WINDOWS_DESKTOP_BUILD: String(build),
      WINDOWS_DESKTOP_CORE_BUILD_RESULT: buildResult,
      WINDOWS_DESKTOP_CORE_E2E_RESULT: shardResult,
    },
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    expected,
    `core=${core},build=${build}: ${buildResult}/${shardResult}: ${result.stdout}${result.stderr}`,
  );
}
assert.ok(
  workflow.includes(
    "node wework/e2e/desktop/run-checkpoints.mjs --memory-only",
  ),
);
console.log("Windows CI event coverage and required-result checks passed");
