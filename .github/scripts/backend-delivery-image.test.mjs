import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  deliveryImageRequired,
  assertHealthy,
  assertStopped,
  assertRouteOwnership,
  collectAndCleanup,
} from "./verify-backend-delivery-image.mjs";

test("evidence write failures cannot prevent container and network cleanup", () => {
  const calls = [];
  const fullDisk = new Error("ENOSPC");
  assert.throws(
    () =>
      collectAndCleanup(() => {
        throw fullDisk;
      }, [() => calls.push("container"), () => calls.push("network")]),
    (error) => error.errors.includes(fullDisk),
  );
  assert.deepEqual(calls, ["container", "network"]);
  const failedCleanup = new Error("cleanup failed");
  assert.throws(
    () =>
      collectAndCleanup(
        () => calls.push("logs"),
        [
          () => {
            throw failedCleanup;
          },
          () => calls.push("last cleanup"),
        ],
      ),
    (error) => error.errors.includes(failedCleanup),
  );
  assert.equal(calls.at(-1), "last cleanup");
  const originalFailure = new Error("route probe failed");
  assert.throws(
    () => collectAndCleanup(() => {}, [], originalFailure),
    (error) => error.errors.includes(originalFailure),
  );
});

test("delivery inputs select the real image without selecting unrelated UI changes", () => {
  for (const file of [
    "docker/backend/Dockerfile",
    "backend/app/main.py",
    "backend-rs/config/routes.toml",
    "shared/setup.py",
    "chat_shell/pyproject.toml",
    "knowledge_engine/pyproject.toml",
    ".dockerignore",
    ".github/scripts/verify-backend-delivery-image.mjs",
    ".github/workflows/e2e-tests.yml",
  ]) {
    assert.equal(deliveryImageRequired([file]), true, file);
  }
  assert.equal(
    deliveryImageRequired(["frontend/src/app/page.tsx", "docs/zh/index.md"]),
    false,
  );
  assert.equal(deliveryImageRequired([]), false);
});

test("classification CLI emits only the CI boolean and supports full regression", () => {
  for (const [input, flags, expected] of [
    ["frontend/src/app/page.tsx\n", [], "false"],
    ["docker/backend/Dockerfile\n", [], "true"],
    ["", ["--force"], "true"],
  ]) {
    const run = spawnSync(
      process.execPath,
      [
        ".github/scripts/verify-backend-delivery-image.mjs",
        "--classify",
        ...flags,
      ],
      { encoding: "utf8", input },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), expected);
  }
});

test("HTTP success and nested health fields cannot hide an unhealthy database", () => {
  assert.doesNotThrow(() =>
    assertHealthy({ status: "healthy", shutting_down: false }),
  );
  assert.throws(() =>
    assertHealthy({ status: "unhealthy", database: "error" }),
  );
  assert.throws(() => assertHealthy({ database: { status: "healthy" } }));
  assert.throws(() =>
    assertHealthy({ status: "healthy", shutting_down: true }),
  );
});

test("shutdown must exit with the expected signal, without OOM or a still-running container", () => {
  assert.doesNotThrow(() =>
    assertStopped({ Running: false, OOMKilled: false, ExitCode: 143 }, 143),
  );
  assert.doesNotThrow(() =>
    assertStopped({ Running: false, OOMKilled: false, ExitCode: 137 }, 137),
  );
  assert.throws(() =>
    assertStopped({ Running: true, OOMKilled: false, ExitCode: 143 }, 143),
  );
  assert.throws(() =>
    assertStopped({ Running: false, OOMKilled: true, ExitCode: 137 }, 137),
  );
  assert.throws(() =>
    assertStopped({ Running: false, OOMKilled: false, ExitCode: 137 }, 143),
  );
});

test("probes fail if route selection no longer covers both real implementations", () => {
  const rust = { methods: ["GET"], path: "/api/users/me" };
  assert.doesNotThrow(() => assertRouteOwnership([rust]));
  assert.throws(() => assertRouteOwnership([]));
  assert.throws(() =>
    assertRouteOwnership([rust, { methods: ["GET"], path: "/api/*path" }]),
  );
  assert.throws(() =>
    assertRouteOwnership([
      rust,
      { methods: ["GET"], path: "/api/knowledge-bases/:id" },
    ]),
  );
});

test("independent runtime and delivery jobs retain their deadlines and required summary gates", () => {
  const workflow = JSON.parse(
    execFileSync(
      "ruby",
      [
        "-ryaml",
        "-rjson",
        "-e",
        "puts JSON.generate(YAML.load_file(ARGV[0]))",
        ".github/workflows/e2e-tests.yml",
      ],
      { encoding: "utf8" },
    ),
  );
  const jobs = workflow.jobs;
  const selection = jobs.changes.steps.find((step) => step.id === "delivery");
  assert.match(selection.run, /git diff --name-only --no-renames/);
  const backend = jobs["build-backend-rs-e2e-runtime"];
  const delivery = jobs["verify-backend-delivery-image"];
  assert.ok(delivery, "Delivery verification needs its own job");
  assert.equal(backend["timeout-minutes"], 25);
  assert.equal(delivery["timeout-minutes"], 60);
  assert.equal(delivery.needs, "changes");
  assert.match(delivery.if, /backend_delivery_image/);
  assert.ok(!backend.if.includes("backend_delivery_image"));
  assert.ok(
    Object.values(delivery.permissions).every((value) => value === "read"),
  );
  assert.ok(
    !backend.steps.some((step) => step.name.includes("Backend delivery")),
    "Runtime production must not include delivery work",
  );
  const builds = Object.values(jobs)
    .flatMap((job) => job.steps ?? [])
    .filter((step) => step.name === "Build Backend delivery image");
  assert.equal(builds.length, 1);
  assert.ok(delivery.steps.includes(builds[0]));
  assert.equal(builds[0].with.file, "docker/backend/Dockerfile");
  assert.equal(builds[0].with.load, true);
  assert.equal(builds[0].with.push, false);
  assert.equal(
    builds[0].with["cache-from"],
    "type=registry,ref=ghcr.io/${{ github.repository_owner }}/wegent-backend:buildcache-amd64",
  );
  assert.equal(builds[0].with["cache-to"], undefined);
  const verify = delivery.steps.find(
    (step) => step.name === "Verify Backend delivery image",
  );
  assert.match(verify.run, /verify-backend-delivery-image\.mjs/);
  assert.match(verify.run, /--revision/);
  const evidence = delivery.steps.find(
    (step) => step.name === "Upload Backend delivery evidence",
  );
  assert.equal(evidence.if, "always()");
  assert.equal(evidence.with.name, "backend-delivery-evidence");
  const summary = jobs["platform-e2e-summary"];
  assert.ok(summary.needs.includes("build-backend-rs-e2e-runtime"));
  assert.ok(summary.needs.includes("verify-backend-delivery-image"));
  const check = summary.steps[0];
  assert.equal(
    check.env.BACKEND_BUILD_RESULT,
    "${{ needs.build-backend-rs-e2e-runtime.result }}",
  );
  assert.equal(
    check.env.DELIVERY_BUILD_RESULT,
    "${{ needs.verify-backend-delivery-image.result }}",
  );
  for (const [
    runtimeSelected,
    deliverySelected,
    runtimeResult,
    deliveryResult,
    expected,
  ] of [
    ["false", "false", "skipped", "skipped", 0],
    ["true", "false", "success", "skipped", 0],
    ["false", "true", "skipped", "success", 0],
    ["true", "true", "success", "success", 0],
    ...["failure", "skipped", "cancelled"].flatMap((result) => [
      ["true", "false", result, "skipped", 1],
      ["true", "true", result, "success", 1],
      ["false", "true", "skipped", result, 1],
      ["true", "true", "success", result, 1],
    ]),
  ]) {
    const run = spawnSync("bash", ["-e", "-c", summary.steps[0].run], {
      encoding: "utf8",
      env: {
        ...process.env,
        CHANGES_RESULT: "success",
        RUN_E2E: "false",
        RUN_BACKEND_RUNTIME: runtimeSelected,
        RUN_DELIVERY: deliverySelected,
        BACKEND_BUILD_RESULT: runtimeResult,
        DELIVERY_BUILD_RESULT: deliveryResult,
      },
    });
    assert.equal(run.status, expected, run.stdout + run.stderr);
  }
});
