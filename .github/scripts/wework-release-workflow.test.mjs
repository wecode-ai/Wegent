import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const workflow = JSON.parse(
  execFileSync(
    "ruby",
    [
      "-ryaml",
      "-rjson",
      "-e",
      "puts JSON.generate(YAML.load_file(ARGV[0]))",
      new URL("../workflows/wework-app.yml", import.meta.url).pathname,
    ],
    { encoding: "utf8" },
  ),
);
const { jobs } = workflow;

test("native writer observation is opt-in and reaches the shared package runner", () => {
  const input =
    workflow.true.workflow_dispatch.inputs.verification_writer_wait_seconds;
  assert.equal(input.type, "number");
  assert.equal(input.default, 0);
  assert.equal(input.required, false);
  const verification = jobs["verify-upgrades"].steps.find(
    (step) =>
      step.name ===
      "Verify declared upgrade and rollback edges on real release packages",
  );
  assert.equal(
    verification.env.WEWORK_E2E_UPGRADE_WRITER_WAIT_SECONDS,
    "${{ inputs.verification_writer_wait_seconds || 0 }}",
  );
  assert.match(
    verification.run,
    /wework\/scripts\/verify-release-upgrades\.mjs/,
  );
});

test("non-publishing artifact builds cannot be cancelled by another release branch queue", () => {
  assert.match(
    workflow.concurrency.group,
    /inputs.build_only && !inputs.publish_release/,
  );
  assert.match(workflow.concurrency.group, /github.ref/);
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
});

test("full unpublished source pairs cannot replace a pending formal release", () => {
  const evaluate = new Function(
    "inputs",
    "github",
    "format",
    `return ${workflow.concurrency.group.slice(3, -2)}`,
  );
  const inputs = {
    build_only: false,
    publish_release: false,
    verification_run_id: "",
    verification_source_run_id: "",
    verification_checkpoint: "all",
  };
  const github = { workflow: "Wework App", ref: "refs/heads/target" };
  const format = (pattern, ...values) =>
    pattern.replace(/\{(\d+)\}/g, (_, index) => values[Number(index)]);
  const release = evaluate(
    { ...inputs, publish_release: true },
    github,
    format,
  );
  const diagnostic = evaluate(
    { ...inputs, verification_source_run_id: "source-run" },
    github,
    format,
  );
  assert.notEqual(diagnostic, release);
  assert.notEqual(
    diagnostic,
    evaluate(
      { ...inputs, verification_source_run_id: "source-run" },
      { ...github, ref: "refs/heads/other" },
      format,
    ),
  );
});

function sparseCheckout(t, checkout, trackedOnly = false) {
  const root = mkdtempSync(join(tmpdir(), "wework-upgrade-resolver-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = new URL("../../", import.meta.url);
  const selections = checkout["sparse-checkout"]
    .trim()
    .split("\n")
    .map((selection) => selection.replace(/^\//, "").replace(/\/$/, ""));
  const paths = trackedOnly
    ? execFileSync("git", ["ls-files", "-z", "--", ...selections], {
        cwd: repository,
        encoding: "utf8",
      })
        .split("\0")
        .filter(Boolean)
    : selections;
  for (const path of paths) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(new URL(path, repository), destination, { recursive: true });
  }
  return root;
}

test("source sparse checkout imports the actual desktop entry graph and release scenario", (t) => {
  const checkout = jobs["verify-upgrades"].steps.find(
    (step) => step.uses === "actions/checkout@v4",
  ).with;
  const root = sparseCheckout(t, checkout, true);
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    await import('./wework/e2e/desktop/modules/task-flow-main.mjs');
    await import('./wework/e2e/desktop/scenarios/retained-upgrade-baseline.scenario.mjs');
    await import('./wework/scripts/lib/packaged-runtime-preparation.mjs');
    await import('./wework/scripts/lib/upgrade-source-prefetch.mjs');
  `,
    ],
    { cwd: root, stdio: "pipe" },
  );
});

test("input resolution pins its source once and its sparse checkout contains all imports", (t) => {
  const steps = jobs["prepare-upgrade-inputs"].steps;
  const checkouts = steps.filter((step) => step.uses === "actions/checkout@v4");
  assert.equal(checkouts.length, 1);
  const resolveInputs = steps.find((step) => step.id === "inputs");
  const checkout = checkouts[0].with;
  assert.equal(checkout.ref, resolveInputs.env.VERIFICATION_SHA);
  assert.equal(checkout["sparse-checkout-cone-mode"], false);
  const root = sparseCheckout(t, checkout);
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    const resolver = await import('./.github/scripts/resolve-wework-upgrade-inputs.mjs');
    if (resolver.upgradeVerificationMatrix('stable').include.length !== 4) throw new Error('Invalid matrix');
    await import('./wework/scripts/lib/upgrade-verification-shards.mjs');
    await import('./wework/scripts/lib/published-upgrade-policies.mjs');
  `,
    ],
    { cwd: root, stdio: "pipe" },
  );
});

test("sparse aggregation loads its policy and rejects missing independent platform evidence", (t) => {
  const checkout = jobs["aggregate-upgrades"].steps.find(
    (step) => step.uses === "actions/checkout@v4",
  ).with;
  const root = sparseCheckout(t, checkout);
  for (const directory of ["plans", "shards"]) mkdirSync(join(root, directory));
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          "wework/scripts/aggregate-release-upgrades.mjs",
          "plans",
          "shards",
          "policies",
        ],
        { cwd: root, stdio: "pipe" },
      ),
    (error) => {
      assert.match(
        error.stderr.toString(),
        /Both independent package platforms require frozen upgrade plans/,
      );
      return true;
    },
  );
});

test("build-only inputs cannot publish or start the serial upgrade verifier", () => {
  assert.match(jobs["prepare-upgrade-inputs"].if, /!inputs.build_only/);
  assert.match(jobs.publish.if, /!inputs.build_only/);
  const rejection = jobs["prepare-release"].steps.find(
    (step) => step.name === "Reject publishing unverified diagnostic inputs",
  );
  assert.equal(rejection.if, "inputs.build_only && inputs.publish_release");
  assert.match(rejection.run, /exit 1/);
});

test("Intel ticket delivery uses TCP before signing while preserving every notarization gate", () => {
  const steps = jobs.build.steps;
  const transport = steps.find(
    (step) =>
      step.name === "Use TCP for Apple ticket delivery on Intel runners",
  );
  assert.equal(
    transport.if,
    "matrix.platform == 'macos' && matrix.arch == 'x64'",
  );
  assert.match(transport.run, /set -euo pipefail/);
  assert.match(
    transport.run,
    /block return out quick proto udp from any to any port 443/,
  );
  assert.match(transport.run, /sudo pfctl -f -/);
  assert.match(transport.run, /sudo pfctl -E/);
  assert.ok(
    steps.indexOf(transport) <
      steps.findIndex((step) => step.name === "Build signed Electron release"),
  );
  assert.doesNotMatch(
    transport.run,
    /stapler|retry|attempt|timeout|notarytool/,
  );
  assert.equal(
    steps.find((step) => step.name === "Build signed Electron release").env
      .WEWORK_CUSTOM_MACOS_NOTARIZATION,
    "${{ matrix.platform == 'macos' && 'true' || '' }}",
  );
});

test("install diagnostics preserve the failing install gate on every platform", () => {
  const install = jobs.build.steps.find(
    (step) => step.id === "workspace-install",
  );
  assert.equal(install.shell, "bash");
  assert.equal(install["continue-on-error"], undefined);
  assert.match(
    install.run,
    /pnpm install --frozen-lockfile --reporter=ndjson \| node/,
  );
  const diagnostics = jobs.build.steps.find(
    (step) => step.name === "Upload workspace install diagnostics",
  );
  assert.equal(
    diagnostics.if,
    "always() && (steps.workspace-install.outcome == 'success' || steps.workspace-install.outcome == 'failure')",
  );
});

test("release creation waits for every candidate build and validation", () => {
  for (const name of ["prepare-release", "build", "verify-upgrades"]) {
    for (const step of jobs[name].steps)
      assert.doesNotMatch(
        step.run ?? "",
        /gh (release (create|edit)|api.*git\/refs)/,
      );
  }
  assert.deepEqual(jobs.publish.needs, [
    "prepare-release",
    "build",
    "prepare-upgrade-inputs",
    "verify-upgrades",
    "aggregate-upgrades",
  ]);
  assert.doesNotMatch(jobs.publish.if, /always\(\)/);
  const names = jobs.publish.steps.map((step) => step.name);
  const create = names.indexOf("Create or update draft release");
  for (const name of [
    "Download release builds",
    "Generate desktop update manifests",
    "Report completed upgrade duration before publication",
  ])
    assert.ok(names.indexOf(name) >= 0 && names.indexOf(name) < create, name);
  assert.ok(create < names.indexOf("Upload formal release assets"));
  const manifests = jobs.publish.steps.find(
    (step) => step.name === "Generate desktop update manifests",
  );
  assert.doesNotMatch(manifests.run, /gh release view/);
  assert.match(manifests.run, /generate-release-notes.mjs/);
  assert.equal(manifests.env.GH_REPO, "${{ github.repository }}");
  for (const name of ["RELEASE_SHA", "PREVIOUS_TAG"])
    assert.ok(manifests.env[name], name);
  const checkout = jobs.publish.steps.find(
    (step) => step.name === "Checkout release source",
  );
  assert.equal(checkout.with["fetch-depth"], 0);
});

test("all installers build while release upgrade E2E runs only on arm64 macOS and Windows", () => {
  assert.deepEqual(
    jobs.build.strategy.matrix.include.map((item) => [
      item.platform,
      item.arch,
    ]),
    [
      ["macos", "arm64"],
      ["macos", "x64"],
      ["windows", "x64"],
      ["linux", "x64"],
    ],
  );
  const native = jobs.build.steps.find(
    (step) => step.name === "Verify native contracts before packaging",
  );
  assert.equal(native.if, undefined);
  assert.match(native.run, /wework\/scripts\/upgrade-credentials\.test\.mjs/);
  for (const name of [
    "Verify declared upgrade and rollback edges on real release packages",
    "Upload verified release upgrade evidence",
  ]) {
    const step = jobs["verify-upgrades"].steps.find(
      (step) => step.name === name,
    );
    const platforms =
      "(matrix.platform == 'macos' && matrix.arch == 'arm64') || matrix.platform == 'windows'";
    assert.equal(
      step.if,
      name === "Upload verified release upgrade evidence"
        ? `needs.prepare-upgrade-inputs.outputs.diagnostic_checkpoint == '' && (${platforms})`
        : platforms,
    );
  }
  const reuse = jobs["aggregate-upgrades"].steps.find(
    (step) =>
      step.name === "Verify macOS architecture equivalence before publication",
  );
  assert.match(reuse.run, /mirror-macos-upgrade-policy.mjs/);
  assert.equal(
    jobs["verify-upgrades"].strategy.matrix,
    "${{ fromJSON(needs.prepare-upgrade-inputs.outputs.verification_matrix) }}",
  );
  assert.equal(jobs["verify-upgrades"].strategy["max-parallel"], 8);
  assert.equal(jobs["verify-upgrades"]["timeout-minutes"], 15);
  assert.equal(jobs.build["timeout-minutes"], 90);
  const step = jobs["verify-upgrades"].steps.find(
    (step) =>
      step.name ===
      "Verify declared upgrade and rollback edges on real release packages",
  );
  assert.equal(step.env.WEWORK_UPGRADE_VERIFY_CHANNEL, "${{ matrix.channel }}");
  const upload = jobs["verify-upgrades"].steps.find(
    (step) => step.name === "Upload verified release upgrade evidence",
  );
  assert.match(upload.with.name, /matrix.channel/);
});

test("upgrade verification only consumes release artifacts and has no signing credentials", () => {
  assert.deepEqual(Object.keys(workflow.on ?? workflow.true), [
    "workflow_dispatch",
  ]);
  assert.equal(
    existsSync(new URL("../workflows/wework-upgrade-e2e.yml", import.meta.url)),
    false,
  );
  const verification = jobs["verify-upgrades"];
  assert.equal(verification.needs, "prepare-upgrade-inputs");
  assert.deepEqual(jobs["prepare-upgrade-inputs"].needs, [
    "prepare-release",
    "build",
  ]);
  assert.deepEqual(verification.permissions, {
    contents: "read",
    actions: "read",
  });
  for (const step of verification.steps) {
    assert.doesNotMatch(JSON.stringify(step), /secrets\./);
    assert.doesNotMatch(
      step.uses ?? "",
      /setup-node-workspace|rust-toolchain|sccache/,
    );
    assert.doesNotMatch(step.run ?? "", /\b(pnpm|npm|cargo|rustc|codesign)\b/);
  }
  const download = verification.steps.find(
    (step) => step.name === "Download prebuilt signed release inputs",
  );
  assert.match(download.with.name, /^wework-upgrade-input-/);
  const producer = jobs.build.steps.find(
    (step) =>
      step.name === "Share immutable release inputs with upgrade verification",
  );
  assert.equal(
    download.with.name.replaceAll("prepare-upgrade-inputs", "prepare-release"),
    producer.with.name,
  );
  assert.equal(
    download.with["run-id"],
    "${{ needs.prepare-upgrade-inputs.outputs.run_id }}",
  );
  assert.equal(
    jobs["prepare-release"].if,
    `inputs.verification_run_id == '' && (inputs.verification_checkpoint == 'all' || (contains(fromJSON('["app-update-refresh","app-update-retry"]'), inputs.verification_checkpoint) && inputs.verification_source_run_id != '' && !inputs.publish_release)) && inputs.verification_release_tag == ''`,
  );
  const source = verification.steps.find(
    (step) => step.name === "Download immutable diagnostic source",
  );
  assert.equal(
    source.if,
    "needs.prepare-upgrade-inputs.outputs.source_run_id != ''",
  );
  assert.equal(
    source.with["run-id"],
    "${{ needs.prepare-upgrade-inputs.outputs.source_run_id }}",
  );
  assert.match(source.with.name, /outputs.source_version/);
  const verify = verification.steps.find(
    (step) =>
      step.name ===
      "Verify declared upgrade and rollback edges on real release packages",
  );
  assert.match(
    verify.env.WEWORK_UPGRADE_SOURCE_ASSETS,
    /outputs.source_run_id != ''/,
  );
  assert.match(jobs["prepare-upgrade-inputs"].if, /!cancelled\(\)/);
  assert.match(
    workflow.concurrency.group,
    /inputs.verification_source_run_id != '' && !inputs.publish_release/,
  );
  const sourceGuard = jobs["prepare-release"].steps.find(
    (step) => step.name === "Reject publishing an unpublished source pair",
  );
  assert.equal(
    sourceGuard.if,
    "inputs.verification_source_run_id != '' && inputs.publish_release",
  );
  assert.ok(
    workflow.true.workflow_dispatch.inputs.verification_checkpoint.options.includes(
      "app-update-refresh",
    ),
  );
  assert.ok(
    workflow.true.workflow_dispatch.inputs.verification_checkpoint.options.includes(
      "app-update-retry",
    ),
  );
  assert.match(verification.if, /!cancelled\(\)/);
});

test("retry without producer IDs routes only to the non-publishing native regression workflow", () => {
  const retry = jobs["retry-regression"];
  assert.equal(retry.uses, "./.github/workflows/wework-upgrade-regression.yml");
  assert.equal(retry.permissions.contents, "read");
  assert.match(retry.if, /verification_checkpoint == 'app-update-retry'/);
  assert.match(retry.if, /verification_source_run_id == ''/);
  assert.match(retry.if, /verification_run_id == ''/);
  assert.match(retry.if, /!inputs.publish_release/);
  assert.match(
    jobs["prepare-upgrade-inputs"].if,
    /!\(inputs.verification_checkpoint == 'app-update-retry'/,
  );
});

test("source runners consume one frozen plan and complete aggregation gates publication", () => {
  const prepare = jobs["prepare-upgrade-inputs"];
  assert.match(
    prepare.outputs.verification_matrix,
    /steps.plan.outputs.matrix/,
  );
  assert.ok(
    prepare.steps.some((step) =>
      step.run?.includes("plan-wework-upgrade-shards.mjs"),
    ),
  );
  const runner = jobs["verify-upgrades"];
  const execute = runner.steps.find((step) =>
    step.run?.includes("verify-release-upgrades.mjs"),
  );
  assert.equal(
    execute.env.WEWORK_UPGRADE_VERIFY_SOURCE,
    "${{ matrix.source_version }}",
  );
  assert.match(execute.env.WEWORK_UPGRADE_PLAN_DIRECTORY, /upgrade-plan/);
  assert.match(runner.name, /matrix.source_version/);
  const aggregate = jobs["aggregate-upgrades"];
  assert.deepEqual(aggregate.needs, [
    "prepare-upgrade-inputs",
    "verify-upgrades",
  ]);
  assert.match(aggregate.if, /diagnostic_checkpoint == ''/);
  assert.ok(
    aggregate.steps.some((step) =>
      step.run?.includes("aggregate-release-upgrades.mjs"),
    ),
  );
  assert.match(
    aggregate.steps.at(-1).run,
    /verify-wework-upgrade-duration.mjs/,
  );
  assert.ok(jobs.publish.needs.includes("aggregate-upgrades"));
});

test("baseline exclusions require explicit dispatch confirmation without bypassing aggregation", () => {
  const inputs = (workflow.on ?? workflow.true).workflow_dispatch.inputs;
  assert.equal(inputs.approved_baseline_exclusions.default, "");
  const aggregate = jobs["aggregate-upgrades"].steps.find((step) =>
    step.run?.includes("aggregate-release-upgrades.mjs"),
  );
  assert.equal(
    aggregate.env.WEWORK_APPROVED_BASELINE_EXCLUSIONS,
    "${{ inputs.approved_baseline_exclusions }}",
  );
  assert.equal(aggregate["continue-on-error"], undefined);
  assert.ok(jobs.publish.needs.includes("aggregate-upgrades"));
});

test("duration remains observable without blocking the verified release", () => {
  for (const name of ["verify-upgrades", "aggregate-upgrades", "publish"]) {
    const timing = jobs[name].steps.filter((step) =>
      step.run?.includes("verify-wework-upgrade-duration.mjs"),
    );
    assert.ok(timing.length > 0, name);
    for (const step of timing) {
      assert.match(step.run, /--report-only/);
      assert.equal(step["continue-on-error"], undefined);
      if (name === "publish") assert.match(step.run, /--completed/);
    }
  }
});

test("lightweight host updates reject both loose component trees and sealed archives", () => {
  const step = jobs.build.steps.find(
    (step) => step.name === "Verify componentized macOS update package",
  );
  const pattern = new RegExp(step.run.match(/grep -E '([^']+)'/)[1]);
  for (const entry of [
    "WeWork.app/Contents/Resources/bin/wegent-executor",
    "WeWork.app/Contents/Resources/wework-core-plugins/wework-app/package.json",
    "WeWork.app/Contents/Resources/wework-core-plugins.tar.gz",
    "WeWork.app/Contents/Resources/wework-app-static.tar.gz",
    "WeWork.app/Contents/Resources/bundled-plugins.tar.gz",
  ])
    assert.match(entry, pattern);
  assert.doesNotMatch("WeWork.app/Contents/Resources/icons/icon.png", pattern);
  const guard = step.run
    .split("\n")
    .find((line) => line.includes("if unzip -Z1"));
  const status = execFileSync(
    "bash",
    [
      "-c",
      `
set -o pipefail
unzip() { printf '%s\\n' 'WeWork.app/Contents/Resources/wework-core-plugins.tar.gz'; seq 1 100000; }
zip=fixture.zip
${guard}
  echo rejected
else
  echo accepted
fi
`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    status.trim(),
    "rejected",
    "A long ZIP listing must not bypass the gate through SIGPIPE",
  );
});

test("dry runs certify security boundaries and x64 identities before any publication", () => {
  const formal = jobs.build.steps.find(
    (step) => step.name === "Verify formal release package",
  );
  assert.match(
    formal.run,
    /release-package-startup,component-update,security-boundaries/,
  );
  assert.equal(formal.env.WEWORK_E2E_PARALLEL_CHECKPOINTS, "1");
  const steps = jobs["aggregate-upgrades"].steps;
  const download = steps.find(
    (step) => step.name === "Download exact macOS x64 package identity",
  );
  assert.equal(
    download.with["run-id"],
    "${{ needs.prepare-upgrade-inputs.outputs.run_id }}",
  );
  assert.equal(
    download.with.name,
    "wework-upgrade-metadata-${{ needs.prepare-upgrade-inputs.outputs.version }}-macos-x64",
  );
  const mirror = steps.find(
    (step) =>
      step.name === "Verify macOS architecture equivalence before publication",
  );
  const upload = steps.find(
    (step) => step.name === "Upload complete verified upgrade policies",
  );
  assert.ok(steps.indexOf(download) < steps.indexOf(mirror));
  assert.ok(steps.indexOf(mirror) < steps.indexOf(upload));
  assert.doesNotMatch(jobs["aggregate-upgrades"].if, /publish_release/);
});
