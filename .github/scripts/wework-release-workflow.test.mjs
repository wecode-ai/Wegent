import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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
    "verify-upgrades",
  ]);
  assert.doesNotMatch(jobs.publish.if, /always\(\)/);
  const names = jobs.publish.steps.map((step) => step.name);
  const create = names.indexOf("Create or update draft release");
  for (const name of [
    "Download release builds",
    "Reuse verified arm64 upgrade paths for macOS x64",
    "Generate desktop update manifests",
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
  const reuse = jobs.publish.steps.find(
    (step) => step.name === "Reuse verified arm64 upgrade paths for macOS x64",
  );
  assert.match(reuse.run, /mirror-macos-upgrade-policy.mjs/);
  assert.deepEqual(
    jobs["verify-upgrades"].strategy.matrix.include.map((item) => [
      item.platform,
      item.arch,
    ]),
    [
      ["macos", "arm64"],
      ["windows", "x64"],
    ],
  );
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
    "inputs.verification_run_id == '' && inputs.verification_checkpoint == 'all' && inputs.verification_release_tag == ''",
  );
  assert.match(jobs["prepare-upgrade-inputs"].if, /!cancelled\(\)/);
  assert.match(verification.if, /!cancelled\(\)/);
});
