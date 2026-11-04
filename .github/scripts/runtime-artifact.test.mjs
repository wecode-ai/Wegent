import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runtimeArtifact } from "./runtime-artifact.mjs";
import { validateMacosRuntimeProducer } from "./restore-macos-ci-runtimes.mjs";

test("native publication requires the exact successful producer and its real checkpoints", () => {
  const run = {
    id: 10,
    head_sha: "a".repeat(40),
    repository: { full_name: "wecode-ai/Wegent" },
    path: ".github/workflows/wework-e2e.yml",
    event: "pull_request",
    status: "completed",
    conclusion: "failure",
  };
  const job = {
    name: "Wework Desktop macOS E2E",
    run_id: 10,
    head_sha: run.head_sha,
    status: "completed",
    conclusion: "success",
    html_url: "producer-url",
    steps: [
      "Run Wework desktop macOS Inspector E2E",
      "Describe verified native macOS runtimes",
      "Upload verified macOS Executor runtime",
      "Upload verified macOS Backend runtime",
    ].map((name) => ({ name, conclusion: "success" })),
  };
  // An unrelated Linux failure does not invalidate a successful native producer.
  assert.deepEqual(validateMacosRuntimeProducer(run, [job]), {
    sha: run.head_sha,
    provenance: job.html_url,
  });
  for (const override of [
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { status: "in_progress" },
    { head_sha: "b".repeat(40) },
    { run_id: 11 },
    { name: "unrelated job" },
    { steps: [] },
    { steps: job.steps.map((step) => ({ ...step, conclusion: "skipped" })) },
  ])
    assert.throws(() =>
      validateMacosRuntimeProducer(run, [{ ...job, ...override }]),
    );
  assert.throws(() => validateMacosRuntimeProducer(run, [job, job]));
  for (const override of [
    { repository: { full_name: "other/Wegent" } },
    { path: ".github/workflows/other.yml" },
    { event: "workflow_dispatch" },
    { conclusion: "cancelled" },
    { head_sha: "invalid" },
  ])
    assert.throws(() =>
      validateMacosRuntimeProducer({ ...run, ...override }, [job]),
    );
});

test("native runtime manifests preserve their target and compilation profile", () => {
  const root = mkdtempSync(join(tmpdir(), "native-runtime-artifact-"));
  try {
    for (const [component, profile] of [
      ["executor", "release"],
      ["backend-rs", "dev"],
    ]) {
      const binary = `wegent-${component}`;
      writeFileSync(join(root, binary), "native runtime bytes");
      const invoke = (
        mode,
        target = "darwin-arm64",
        expectedProfile = profile,
      ) =>
        runtimeArtifact(
          mode,
          root,
          component,
          "source-key",
          [binary],
          "head",
          target,
          expectedProfile,
        );
      invoke("create");
      const manifest = JSON.parse(
        readFileSync(join(root, `${component}-runtime-manifest.json`), "utf8"),
      );
      assert.equal(manifest.target, "darwin-arm64");
      assert.equal(manifest.profile, profile);
      invoke("verify");
      assert.throws(() => invoke("verify", "linux-x64"), /target mismatch/);
      assert.throws(
        () =>
          invoke(
            "verify",
            "darwin-arm64",
            profile === "dev" ? "release" : "dev",
          ),
        /profile mismatch/,
      );
      assert.throws(() => invoke("verify", "darwin-arm64", "other"), /profile/);
      assert.throws(() => invoke("create", "unknown"), /target/);
      writeFileSync(join(root, binary), "modified native payload");
      assert.throws(() => invoke("verify"), /checksum mismatch/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime handoff selects the correct native producer and rejects incompatible payloads", () => {
  const root = mkdtempSync(join(tmpdir(), "native-runtime-handoff-"));
  try {
    const scripts = join(root, "scripts");
    const scratch = join(root, "scratch");
    mkdirSync(scripts);
    mkdirSync(scratch);
    for (const name of ["restore-actions-runtime.sh", "runtime-artifact.mjs"])
      copyFileSync(new URL(name, import.meta.url), join(scripts, name));
    const downloader = join(scripts, "download-actions-artifact.sh");
    writeFileSync(
      downloader,
      `#!/usr/bin/env bash
set -euo pipefail
test "$ACTIONS_ARTIFACT_JOB" = "$TEST_PRODUCER_JOB"
mkdir -p "$2"
printf '#!/bin/sh\\nexit 0\\n' > "$2/$TEST_BINARY"
RUNTIME_HEAD_SHA="$ACTIONS_ARTIFACT_HEAD_SHA" RUNTIME_TARGET="$TEST_MANIFEST_TARGET" RUNTIME_PROFILE="$TEST_MANIFEST_PROFILE" \\
  node "$(dirname "$0")/runtime-artifact.mjs" create "$2" "$TEST_COMPONENT" source-key "$TEST_BINARY"
`,
    );
    chmodSync(downloader, 0o755);
    let attempt = 0;
    for (const [artifact, component, target, profile, producer] of [
      [
        "executor-e2e-binary",
        "executor",
        "linux-x64",
        "release",
        "Prepare Executor E2E Runtime",
      ],
      [
        "backend-rs-e2e-runtime",
        "backend-rs",
        "linux-x64",
        "release",
        "Build Backend Rust E2E Runtime",
      ],
      [
        "macos-executor-e2e-binary",
        "executor",
        "darwin-arm64",
        "release",
        "Wework Desktop macOS E2E",
      ],
      [
        "macos-backend-rs-e2e-runtime",
        "backend-rs",
        "darwin-arm64",
        "dev",
        "Wework Desktop macOS E2E",
      ],
    ]) {
      const run = (manifestTarget, manifestProfile) => {
        const destination = join(root, `output-${attempt++}`);
        const result = spawnSync(
          "bash",
          [
            join(scripts, "restore-actions-runtime.sh"),
            artifact,
            component,
            `wegent-${component}`,
            "source-key",
            destination,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              TMPDIR: scratch,
              ACTIONS_ARTIFACT_HEAD_SHA: "head",
              RUNTIME_TARGET: "unexpected-ambient-target",
              RUNTIME_PROFILE: "unexpected-ambient-profile",
              TEST_PRODUCER_JOB: producer,
              TEST_COMPONENT: component,
              TEST_BINARY: `wegent-${component}`,
              TEST_MANIFEST_TARGET: manifestTarget,
              TEST_MANIFEST_PROFILE: manifestProfile,
            },
          },
        );
        assert.deepEqual(
          readdirSync(scratch),
          [],
          "handoff must clean temporary files",
        );
        if (result.status === 0)
          assert.match(readFileSync(destination, "utf8"), /exit 0/);
        else assert.equal(existsSync(destination), false);
        return result;
      };
      const success = run(target, profile);
      assert.equal(success.status, 0, success.stderr);
      const wrongTarget = run(
        target === "linux-x64" ? "darwin-arm64" : "linux-x64",
        profile,
      );
      assert.notEqual(wrongTarget.status, 0);
      assert.match(wrongTarget.stderr, /target mismatch/);
      const wrongProfile = run(target, profile === "dev" ? "release" : "dev");
      assert.notEqual(wrongProfile.status, 0);
      assert.match(wrongProfile.stderr, /profile mismatch/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime artifacts bind source, platform, profile and complete file contents", () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-artifact-"));
  try {
    writeFileSync(join(root, "server"), "binary");
    const invoke = (mode, sha = "head") =>
      runtimeArtifact(
        mode,
        root,
        "backend-rs",
        "image@digest",
        ["server"],
        sha,
      );
    invoke("create");
    invoke("verify");
    assert.throws(() => invoke("verify", "other"), /headSha mismatch/);
    const path = join(root, "backend-rs-runtime-manifest.json");
    const original = readFileSync(path, "utf8");
    for (const key of ["sourceRef", "target", "profile", "schema"]) {
      writeFileSync(
        path,
        JSON.stringify({ ...JSON.parse(original), [key]: "other" }),
      );
      assert.throws(() => invoke("verify"), /mismatch/);
    }
    writeFileSync(path, original);
    writeFileSync(join(root, "server"), "tamper");
    assert.throws(() => invoke("verify"), /checksum mismatch/);
    rmSync(join(root, "server"));
    assert.throws(() => invoke("verify"), /ENOENT/);
    symlinkSync(path, join(root, "server"));
    assert.throws(() => invoke("verify"), /regular file/);
    const manifest = JSON.parse(original);
    manifest.files[0].name = "../outside";
    writeFileSync(path, JSON.stringify(manifest));
    assert.throws(() => invoke("verify"), /Missing runtime file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
