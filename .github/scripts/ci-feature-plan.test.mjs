import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  desktopIds,
  filterDesktop,
  loadCatalog,
  readClassifier,
} from "./ci-feature-catalog.mjs";
import { assertCurrentPlan, buildPlan } from "./ci-feature-plan.mjs";
import {
  ciLabels,
  executorProjectGroups,
  executorProjects,
  integrationChecks,
} from "./ci-feature-policy.mjs";
import { playwrightInvocation } from "./run-feature-playwright.mjs";

const root = resolve(import.meta.dirname, "../..");
const catalog = await loadCatalog(root);
const planFor = (files, labels, extra = {}) =>
  buildPlan({
    files,
    labels,
    head: "head",
    base: "base",
    catalog,
    legacyDesktop: {
      ...catalog.all,
      wework_desktop_macos_inspector_e2e: "false",
    },
    ...extra,
  });
const entries = (output) => JSON.parse(output).include;

test("classifier output uses a regular file and ignores diagnostic stdout", () => {
  const fixture = mkdtempSync(resolve(tmpdir(), "ci-classifier-output-"));
  try {
    mkdirSync(resolve(fixture, ".github/scripts"), { recursive: true });
    writeFileSync(
      resolve(fixture, ".github/scripts/probe.sh"),
      `#!/usr/bin/env bash\nset -euo pipefail\n[[ -f "$GITHUB_OUTPUT" ]]\n[[ "$GITHUB_OUTPUT" != /dev/* ]]\nprintf 'diagnostic only\\n'\nprintf 'enabled=true\\n' >> "$GITHUB_OUTPUT"\n`,
    );
    assert.deepEqual(readClassifier(fixture, "probe.sh", []), {
      enabled: "true",
    });
    writeFileSync(resolve(fixture, ".github/scripts/failure.sh"), "exit 17\n");
    assert.throws(
      () => readClassifier(fixture, "failure.sh", []),
      /Command failed/,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("every physical desktop entry and platform spec has a registered feature", () => {
  const actual = new Set(
    Object.values(catalog.features).flatMap((feature) => feature.desktop),
  );
  assert.deepEqual(actual, desktopIds(catalog.all, catalog.plugins));
  assert.equal(Object.keys(catalog.features).length, 14);
  assert(catalog.specOwners.size > 70);
});

test("missing, duplicate and unknown catalog entries are rejected before scheduling", async () => {
  const fixture = mkdtempSync(resolve(tmpdir(), "ci-feature-catalog-"));
  try {
    mkdirSync(resolve(fixture, ".github/ci"), { recursive: true });
    for (const name of ["wework", "frontend"])
      symlinkSync(resolve(root, name), resolve(fixture, name), "dir");
    for (const name of ["scripts", "workflows"])
      symlinkSync(
        resolve(root, ".github", name),
        resolve(fixture, ".github", name),
        "dir",
      );
    const mutations = [
      (data) => {
        data.features.chat.desktop = data.features.chat.desktop.filter(
          (id) => id !== "core:voice-input",
        );
      },
      (data) => {
        data.features.chat.specs.shift();
      },
      (data) => {
        data.features.chat.desktop.push("core:unregistered-checkpoint");
      },
      (data) => {
        data.features.workspace.specs.push(data.features.chat.specs[0]);
      },
      (data) => {
        data.version = 99;
      },
    ];
    for (const mutate of mutations) {
      const data = JSON.parse(catalog.text);
      mutate(data);
      writeFileSync(
        resolve(fixture, ".github/ci/features.json"),
        JSON.stringify(data),
      );
      await assert.rejects(
        loadCatalog(fixture),
        /no feature|Unknown|Duplicate|Unsupported/,
      );
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("required labels retain affected client ownership and narrow existing desktop prerequisites", () => {
  const desktopOnly = planFor(
    ["wework/src/components/chat/MessageList.tsx"],
    ["ci:chat"],
    { surfaces: { platform: false, desktop: true } },
  );
  assert.equal(desktopOnly.outputs.platform_e2e, "false");
  const webOnly = planFor(
    ["frontend/src/components/chat/MessageList.tsx"],
    ["ci:chat"],
    { surfaces: { platform: true, desktop: false } },
  );
  assert.equal(webOnly.outputs.wework_desktop_e2e, "false");
  const previous = filterDesktop(
    catalog.all,
    new Set(["core:streaming-tools", "core:runtime-input-answer-persistence"]),
    catalog.plugins,
  );
  const narrow = planFor(
    ["wework/src/components/chat/MessageList.tsx"],
    ["ci:chat"],
    { surfaces: { platform: false, desktop: true }, legacyDesktop: previous },
  );
  assert.deepEqual(
    desktopIds(narrow.outputs, catalog.plugins),
    desktopIds(previous, catalog.plugins),
  );
  const widened = planFor(
    ["wework/src/components/chat/MessageList.tsx"],
    ["ci:chat", "ci:knowledge"],
    { surfaces: { platform: false, desktop: true } },
  );
  assert.equal(widened.outputs.platform_e2e, "true");
  assert(
    widened.plan.specs.every(
      (spec) => catalog.specOwners.get(spec.file).feature === "knowledge",
    ),
  );
  const windows = planFor(
    ["frontend/src/components/chat/MessageList.tsx"],
    ["ci:chat", "ci:windows"],
    { surfaces: { platform: true, desktop: false } },
  );
  assert.equal(windows.outputs.windows_desktop_core_e2e, "true");
});

test("draft plans defer every expensive suite without erasing label requirements", () => {
  const { plan, outputs } = planFor([], ["ci:all"], { draft: true });
  assert.equal(plan.draft, true);
  for (const key of [
    "platform_e2e",
    "platform_suite",
    "executor_suite",
    "wework_e2e",
    "wework_desktop_e2e",
    "windows_desktop_core_e2e",
    "wework_desktop_macos_inspector_e2e",
  ])
    assert.equal(outputs[key], "false", key);
  assert(
    planFor(["wework/src/components/chat/MessageList.tsx"], [], { draft: true })
      .plan.errors.length,
  );
});

test("catalog project assignments agree with the actual Playwright configuration", () => {
  const source = readFileSync(
    resolve(root, "frontend/playwright.config.ts"),
    "utf8",
  )
    .replace(/^import .*$/m, "")
    .replace(
      "export default defineConfig(",
      "globalThis.config = defineConfig(",
    );
  const context = {
    defineConfig: (value) => value,
    devices: { "Desktop Chrome": {} },
    process: { env: { CI: "true" } },
  };
  vm.runInNewContext(source, context);
  const candidates = context.config.projects.filter((project) =>
    [
      "chromium",
      "api",
      "provider-native-chromium",
      ...executorProjects,
    ].includes(project.name),
  );
  for (const spec of catalog.specOwners.values()) {
    const matches = candidates.filter((project) => {
      const ignored = []
        .concat(project.testIgnore ?? [])
        .some((pattern) => pattern.test(spec.file));
      return (
        !ignored && (!project.testMatch || project.testMatch.test(spec.file))
      );
    });
    assert.deepEqual(
      Array.from(matches, (project) => project.name),
      [spec.project],
      spec.file,
    );
  }
});

test("missing labels and unknown labels stop all expensive suites", () => {
  for (const labels of [[], ["ci:chat"], ["ci:plguins"]]) {
    const { plan, outputs } = planFor(
      ["wework/src/features/plugins/PluginAutoUpdateCoordinator.tsx"],
      labels,
    );
    assert(plan.errors.length);
    assert.equal(outputs.platform_e2e, "false");
    assert.equal(outputs.wework_desktop_e2e, "false");
    assert.equal(outputs.wework_e2e, "false");
    assert.equal(outputs.windows_desktop_core_e2e, "false");
    assert.equal(outputs.wework_desktop_macos_inspector_e2e, "false");
  }
});

test("known feature paths require their own labels and no unrelated desktop suite", () => {
  const { plan, outputs } = planFor(
    ["backend/app/services/knowledge/dingtalk_import.py"],
    ["ci:knowledge"],
  );
  assert.deepEqual(plan.required, ["ci:knowledge"]);
  assert.deepEqual(plan.errors, []);
  assert.equal(outputs.wework_desktop_e2e, "false");
  assert.equal(outputs.executor_suite, "false");
  assert(plan.checks.includes("knowledge_index"));
  assert(!plan.checks.includes("subscriptions"));
  assert(!plan.checks.includes("attachments"));
});

test("plugins select plugin Core, Cloud and dedicated cases without platform E2E", () => {
  const { plan, outputs } = planFor(
    ["wework/src/features/plugins/PluginAutoUpdateCoordinator.tsx"],
    ["ci:plugins"],
  );
  assert.deepEqual(plan.errors, []);
  assert.equal(outputs.platform_e2e, "false");
  assert.equal(outputs.wework_desktop_other_e2e, "true");
  const selected = desktopIds(outputs, catalog.plugins);
  assert(selected.has("cloud:plugin-periodic-reconcile"));
  assert(selected.has("core:plugin-development"));
  assert(!selected.has("core:goal-lifecycle"));
});

test("feature unions deduplicate identical profile/checkpoint pairs, not local/cloud coverage", () => {
  const { outputs } = planFor([], ["ci:chat", "ci:runtime", "ci:chat"]);
  const ids = desktopIds(outputs, catalog.plugins);
  assert(ids.has("core:conversation-state"));
  assert(ids.has("cloud:conversation-state"));
  const checkpoints = Object.entries(outputs)
    .filter(([key]) => key.endsWith("_matrix"))
    .flatMap(([key, value]) =>
      entries(value).flatMap((entry) =>
        (entry.segments ?? entry.segment ?? "")
          .split(",")
          .filter(Boolean)
          .map((name) => `${key}:${name}`),
      ),
    );
  assert.equal(checkpoints.length, new Set(checkpoints).size);
});

test("unknown product code and lockfiles require explicit ci:all", () => {
  for (const path of ["backend-rs/src/new_domain.rs", "pnpm-lock.yaml"]) {
    assert(
      planFor([path], ["ci:runtime"]).plan.missing.includes("ci:all"),
      path,
    );
    assert.deepEqual(planFor([path], ["ci:all"]).plan.errors, [], path);
  }
});

test("E2E test changes require coverage while ordinary unit tests remain path checked", () => {
  for (const path of [
    "wework/e2e/tests/chat.spec.ts",
    "wework/e2e/desktop/checkpoint-scheduler.test.mjs",
    "frontend/e2e/helpers/session.test.ts",
  ]) {
    assert.deepEqual(planFor([path], []).plan.missing, ["ci:all"], path);
    const { plan, outputs } = planFor([path], ["ci:all"]);
    assert.deepEqual(plan.errors, [], path);
    assert.equal(outputs.platform_suite, "true");
    assert.equal(outputs.wework_e2e, "true");
  }
  assert.deepEqual(
    planFor(["wework/src/components/chat/MessageList.test.tsx"], []).plan
      .required,
    [],
  );
});

test("label synchronization only executes trusted main code", () => {
  const workflow = JSON.parse(
    execFileSync(
      "ruby",
      [
        "-ryaml",
        "-rjson",
        "-e",
        "puts JSON.generate(YAML.load_file(ARGV[0]))",
        resolve(root, ".github/workflows/ci-feature-labels.yml"),
      ],
      { encoding: "utf8" },
    ),
  );
  for (const ref of [
    "refs/heads/main",
    "refs/heads/feature/unreviewed",
    "refs/tags/main",
  ]) {
    assert.equal(
      vm.runInNewContext(workflow.jobs.labels.if, { github: { ref } }),
      ref === "refs/heads/main",
    );
  }
});

test("CI policy edits without label-write permission execute complete coverage", () => {
  for (const path of [
    ".github/ci/features.json",
    ".github/scripts/ci-feature-plan.mjs",
    ".github/workflows/wework-e2e.yml",
    ".github/actions/future-shared-action/action.yml",
  ]) {
    const { plan, outputs } = planFor([path], []);
    assert.deepEqual(plan.errors, [], path);
    assert.equal(plan.automaticFull, true);
    assert.equal(plan.full, true);
    assert.equal(outputs.memory_suite, "true");
    assert.equal(outputs.windows_desktop_core_e2e, "true");
    assert.equal(outputs.wework_desktop_macos_inspector_e2e, "true");
    assert.equal(plan.specs.length, catalog.specOwners.size);
    assert.deepEqual(plan.checks, Object.keys(integrationChecks));
    for (const suite of ["core", "cloud", "other"])
      assert.equal(
        outputs[`wework_desktop_${suite}_e2e_matrix`],
        catalog.all[`wework_desktop_${suite}_e2e_matrix`],
      );
    const modules = readClassifier(root, "classify-ci-changes.sh", [path]);
    assert(Object.values(modules).every((value) => value === "true"));
    assert.equal(
      readClassifier(root, "classify-plugin-auth-sdk.sh", [path])
        .plugin_auth_sdk,
      "true",
    );
  }
  assert.equal(
    planFor(["wework/src/components/chat/MessageList.tsx"], ["ci:chat"]).outputs
      .memory_suite,
    "false",
  );
  assert.equal(planFor([], ["ci:release"]).outputs.memory_suite, "false");
  assert.equal(
    planFor([], [], { event: "schedule" }).outputs.memory_suite,
    "false",
  );
});

test("registered CI consumers exercise their suites without requiring product labels", () => {
  for (const [path, targets, platform, desktop] of [
    [
      ".github/ci/wework-unit-test-durations.json",
      ["wework"],
      "false",
      "false",
    ],
    [
      ".github/actions/build-frontend-e2e/action.yml",
      ["platform_e2e"],
      "true",
      "false",
    ],
    [
      ".github/actions/setup-node-workspace/action.yml",
      ["frontend", "platform_e2e", "wework", "wework_e2e"],
      "true",
      "true",
    ],
    [
      ".github/actions/build-wework-core-e2e/action.yml",
      ["wework_e2e"],
      "false",
      "true",
    ],
    [
      ".github/scripts/core-runner-slots.mjs",
      ["wework_e2e"],
      "false",
      "true",
    ],
  ]) {
    const { plan, outputs } = planFor([path], []);
    assert.deepEqual(plan.errors, [], path);
    assert.deepEqual(plan.scopedTargets, targets, path);
    assert.equal(plan.automaticFull, false, path);
    assert.equal(outputs.platform_suite, platform, path);
    assert.equal(outputs.executor_suite, platform, path);
    assert.equal(outputs.wework_e2e, desktop, path);
    assert.equal(outputs.memory_suite, "false", path);
  }
  const { plan } = planFor(
    [
      ".github/actions/setup-node-workspace/action.yml",
      "wework/src/components/chat/MessageList.tsx",
    ],
    [],
  );
  assert(plan.errors.includes("Missing required label: ci:chat"));
});

test("docs-only work needs no feature suite; permission contracts remain covered", () => {
  const { plan, outputs } = planFor(
    ["AGENTS.md", "docs/zh/wework/tasks.md"],
    [],
  );
  assert.deepEqual(plan.errors, []);
  assert.equal(outputs.platform_e2e, "false");
  assert.equal(outputs.wework_desktop_e2e, "false");
  assert.deepEqual(
    planFor(["docs/en/wegent/developer-guide/collaboration-permissions.md"], [])
      .plan.required,
    ["ci:auth", "ci:collaboration"],
  );
});

test("ci:all, release, nightly and dispatch preserve complete existing matrices", () => {
  for (const extra of [
    { labels: ["ci:all"] },
    { labels: ["ci:release"] },
    { labels: [], event: "schedule" },
    { labels: [], event: "workflow_dispatch" },
  ]) {
    const { plan, outputs } = planFor([], extra.labels, extra);
    assert(plan.full);
    for (const key of ["core", "cloud", "other"])
      assert.equal(
        outputs[`wework_desktop_${key}_e2e_matrix`],
        catalog.all[`wework_desktop_${key}_e2e_matrix`],
      );
    assert.equal(outputs.platform_suite, "true");
    assert.equal(outputs.executor_suite, "true");
    assert.deepEqual(plan.checks, Object.keys(integrationChecks));
    assert.equal(plan.platformMatrix.length, 8);
    assert.deepEqual(
      plan.platformMatrix.map((entry) => entry.providerShardIndex),
      [3, 2, 1, 4, 5, 6, 7, 8],
    );
  }
});

test("merge queue uses its own desktop product diff without Windows or macOS expansion", () => {
  const legacy = filterDesktop(
    catalog.all,
    new Set(["core:streaming-content"]),
    catalog.plugins,
  );
  const { outputs } = planFor([], [], {
    event: "merge_group",
    legacyDesktop: legacy,
  });
  assert.deepEqual(
    [...desktopIds(outputs, catalog.plugins)],
    ["core:streaming-content"],
  );
  assert.equal(outputs.windows_desktop_core_e2e, "false");
  assert.equal(outputs.wework_desktop_macos_inspector_e2e, "false");
  assert.equal(outputs.platform_suite, "true");
});

test("platform modifiers cannot make missing functional labels or nonexistent coverage pass", () => {
  assert(
    planFor(["wework/src/components/chat/MessageList.tsx"], ["ci:windows"]).plan
      .errors.length,
  );
  assert(planFor([], ["ci:knowledge", "ci:windows"]).plan.errors.length);
  const { outputs } = planFor([], ["ci:chat", "ci:windows"]);
  assert.equal(outputs.windows_desktop_core_e2e, "true");
  assert.equal(outputs.wework_desktop_macos_inspector_e2e, "false");
});

test("partitioned platform plans execute each selected spec and independent command exactly as registered", () => {
  for (const feature of Object.keys(catalog.features).filter(
    (name) => name !== "release",
  )) {
    const { plan } = planFor([], [`ci:${feature}`]);
    const files = plan.platformMatrix
      .flatMap((entry) => [...entry.specs, ...entry.provider])
      .sort();
    assert.deepEqual(
      files,
      plan.specs
        .filter((spec) => !executorProjects.includes(spec.project))
        .map((spec) => spec.file)
        .sort(),
      feature,
    );
    assert(plan.platformMatrix.length <= 8);
    for (const entry of plan.platformMatrix) {
      assert.equal(entry.shardTotal, 8);
      assert.equal(
        entry.providerShardIndex,
        [3, 2, 1, 4, 5, 6, 7, 8][entry.shardIndex - 1],
      );
      assert.equal(
        entry.dingtalkOAuth,
        entry.checks.includes("dingtalk_documents"),
      );
    }
    for (const check of plan.checks) {
      assert.deepEqual(
        plan.platformMatrix
          .filter((entry) => entry.checks.includes(check))
          .map((entry) => entry.shardIndex),
        integrationChecks[check].shards,
      );
    }
  }
});

test("Executor labels select the matching Playwright projects", () => {
  const args = ["--project=executor-chromium"];
  const { plan, outputs } = planFor([], ["ci:collaboration"]);
  assert.equal(outputs.executor_suite, "true");
  const device = playwrightInvocation(plan, args);
  assert.equal(device[0], "--project=executor-device-chromium");
  assert(!device.includes(args[0]));
  assert(
    device.some((arg) => arg.endsWith("issue-dispatch-executor\\.spec\\.ts$")),
  );

  const runtime = playwrightInvocation(planFor([], ["ci:runtime"]).plan, args);
  assert.deepEqual(
    runtime.filter((arg) => arg.startsWith("--project=")),
    executorProjectGroups[0].map((project) => `--project=${project}`),
  );
  assert(
    runtime.some((arg) =>
      arg.endsWith("claude-background-lifecycle\\.spec\\.ts$"),
    ),
  );
});

test("stalled execution coverage retains its isolated short-threshold Backend phase", () => {
  const { plan, outputs } = planFor([], ["ci:runtime"]);
  const file = "tasks/chat-stalled-execution.spec.ts";
  assert.equal(catalog.specOwners.get(file).feature, "runtime");
  assert.equal(outputs.executor_suite, "true");
  const regular = playwrightInvocation(plan, ["--project=executor-chromium"]);
  assert(!regular.includes("--project=executor-stalled-chromium"));
  assert(
    !regular.some((argument) => argument.includes("chat-stalled-execution")),
  );
  const args = [
    "--project=executor-stalled-chromium",
    "--output=test-results-stalled",
  ];
  const stalled = playwrightInvocation(plan, args);
  assert.deepEqual(
    stalled.filter((argument) => argument.startsWith("--project=")),
    [args[0]],
  );
  assert(stalled.includes(args[1]));
  assert(
    stalled.some((argument) =>
      argument.endsWith("chat-stalled-execution\\.spec\\.ts$"),
    ),
  );
  assert.equal(
    playwrightInvocation(planFor([], ["ci:workspace"]).plan, args),
    null,
  );
  assert.deepEqual(
    playwrightInvocation(planFor([], ["ci:all"]).plan, args),
    args,
  );
  assert.throws(
    () => playwrightInvocation(plan, [args[0], "--project=executor-chromium"]),
    /separate invocations/,
  );
});

test("provider-only shards provision auth and keep serial/no-deps execution", () => {
  const knowledge = catalog.features.knowledge;
  const providerCatalog = {
    ...catalog,
    features: {
      ...catalog.features,
      knowledge: {
        ...knowledge,
        specs: knowledge.specs.filter(
          (spec) => spec.project === "provider-native-chromium",
        ),
      },
    },
  };
  const { plan } = planFor([], ["ci:knowledge"], {
    catalog: providerCatalog,
  });
  const bucket = plan.platformMatrix.find(
    (entry) => entry.provider.length && !entry.specs.length,
  );
  assert(bucket);
  assert.deepEqual(
    playwrightInvocation(plan, [
      "--project=chromium",
      "--project=api",
      `--shard=${bucket.shardIndex}/8`,
    ]),
    ["--project=setup"],
  );
  const args = playwrightInvocation(plan, [
    "--project=provider-native-chromium",
    "--workers=1",
    `--shard=${bucket.providerShardIndex}/8`,
    "--no-deps",
  ]);
  assert(args.includes("--workers=1"));
  assert(args.includes("--no-deps"));
  assert(!args.some((arg) => arg.startsWith("--shard=")));
  assert(args.some((arg) => arg.endsWith("dingtalk-import\\.spec\\.ts$")));
});

test("unknown shards fail and full runs retain the exact Playwright shard command", () => {
  const { plan } = planFor([], ["ci:knowledge"]);
  assert.throws(
    () => playwrightInvocation(plan, ["--project=api", "--shard=99/8"]),
    /absent/,
  );
  const args = ["--project=api", "--shard=1/8"];
  assert.deepEqual(
    playwrightInvocation(planFor([], ["ci:all"]).plan, args),
    args,
  );
});

test("removed labels, changed heads and retargeting invalidate successful old plans", () => {
  const { plan } = planFor([], ["ci:plugins"]);
  const current = {
    head: { sha: "head" },
    base: { sha: "base", ref: "main" },
    labels: [{ name: "ci:plugins" }],
  };
  assert.doesNotThrow(() => assertCurrentPlan(plan, current));
  for (const changed of [
    { ...current, labels: [] },
    { ...current, head: { sha: "new" } },
    { ...current, base: { sha: "base", ref: "other" } },
  ])
    assert.throws(() => assertCurrentPlan(plan, changed), /changed/);
  assert.doesNotThrow(() =>
    assertCurrentPlan(plan, {
      ...current,
      base: { sha: "advanced-main", ref: "main" },
    }),
  );
});

test("unrelated labels do not select, cancel or replace canonical CI checks", () => {
  assert.deepEqual(ciLabels(["bug", "ci:chat", "ci:chat"]), ["ci:chat"]);
  for (const file of ["e2e-tests.yml", "wework-e2e.yml"]) {
    const workflow = readFileSync(
      resolve(root, ".github/workflows", file),
      "utf8",
    );
    assert(workflow.includes("&& 'metadata' || 'code'"));
    assert(workflow.includes("Ignored label metadata"));
    assert(workflow.includes("github.event.action != 'unlabeled'"));
    assert(workflow.includes("node .github/scripts/check-ci-feature-plan.mjs"));
    const parsed = JSON.parse(
      execFileSync(
        "ruby",
        [
          "-ryaml",
          "-rjson",
          "-e",
          "puts JSON.generate(YAML.load_file(ARGV[0]))",
          resolve(root, ".github/workflows", file),
        ],
        { encoding: "utf8" },
      ),
    );
    const evaluate = (expression, label) =>
      vm.runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/g, ""), {
        github: {
          event_name: "pull_request",
          event: {
            action: "labeled",
            label: { name: label },
            pull_request: { draft: false },
          },
        },
        startsWith: (value, prefix) => value.startsWith(prefix),
      });
    assert.equal(evaluate(parsed.jobs.changes.if, "bug"), false);
    assert.equal(evaluate(parsed.jobs.changes.if, "ci:chat"), true);
    const summary =
      parsed.jobs[
        file === "wework-e2e.yml"
          ? "wework-e2e-summary"
          : "platform-e2e-summary"
      ];
    assert(evaluate(summary.name, "bug").startsWith("Ignored label metadata"));
    assert(evaluate(summary.name, "ci:chat").endsWith("E2E Summary"));
  }
});

test("every independent platform integration command is gated by its registered feature", () => {
  const workflow = readFileSync(
    resolve(root, ".github/workflows/e2e-tests.yml"),
    "utf8",
  );
  // The matrix gates the OAuth fixture, capabilities, and tests together.
  for (const id of Object.keys(integrationChecks).filter(
    (id) => id !== "dingtalk_documents",
  ))
    assert(
      workflow.includes(
        `contains(fromJSON(env.CI_FEATURE_PLAN).checks, '${id}')`,
      ),
      id,
    );
  assert(workflow.includes("--env CI_FEATURE_PLAN"));
  assert(workflow.includes("RUN_PLATFORM_SUITE"));
  assert(workflow.includes("RUN_EXECUTOR_SUITE"));
});

test("workflow YAML remains valid and includes the planner in the existing summary dependencies", () => {
  for (const file of [
    "e2e-tests.yml",
    "wework-e2e.yml",
    "ci-feature-labels.yml",
  ]) {
    const path = resolve(root, ".github/workflows", file);
    execFileSync("ruby", ["-ryaml", "-e", "YAML.load_file(ARGV[0])", path]);
  }
});
