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

test("the existing backend job builds and verifies one real delivery image and the summary gates it", () => {
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
  const builds = backend.steps.filter(
    (step) => step.name === "Build Backend delivery image",
  );
  assert.equal(builds.length, 1);
  assert.equal(builds[0].with.file, "docker/backend/Dockerfile");
  assert.equal(builds[0].with.load, true);
  assert.equal(builds[0].with.push, false);
  assert.match(builds[0].if, /backend_delivery_image/);
  const verify = backend.steps.find(
    (step) => step.name === "Verify Backend delivery image",
  );
  assert.match(verify.run, /verify-backend-delivery-image\.mjs/);
  assert.match(verify.run, /--revision/);
  const summary = jobs["platform-e2e-summary"];
  assert.ok(summary.needs.includes("build-backend-rs-e2e-runtime"));
  assert.match(summary.steps[0].run, /assert_success "\$BACKEND_BUILD_RESULT"/);
  for (const [selected, result, expected] of [
    ["true", "failure", 1],
    ["true", "skipped", 1],
    ["true", "success", 0],
    ["false", "skipped", 0],
  ]) {
    const run = spawnSync("bash", ["-e", "-c", summary.steps[0].run], {
      encoding: "utf8",
      env: {
        ...process.env,
        CHANGES_RESULT: "success",
        RUN_E2E: "false",
        RUN_DELIVERY: selected,
        BACKEND_BUILD_RESULT: result,
      },
    });
    assert.equal(run.status, expected, run.stdout + run.stderr);
  }
});
