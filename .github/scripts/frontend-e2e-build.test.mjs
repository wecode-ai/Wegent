import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  archiveName,
  manifestName,
  frontendBuild,
  describeBuild,
  verifyBuild,
  attestBuild,
  frontendBuildEnvironment,
} from "./frontend-e2e-build.mjs";
import {
  artifactType,
  restoreFrontendBuild,
  publishFrontendBuild,
} from "./frontend-e2e-build-oci.mjs";
import { restoreFrontendFromCi } from "./restore-frontend-ci-build.mjs";

const context = {
  profile: "e2e-standalone-v1",
  platform: "linux-x64",
  node: "v24.14.1",
  nodeAbi: "137",
  glibc: "2.39",
  pnpm: "11.7.0",
  next: "15.5.14",
  environment: { NODE_ENV: "production" },
};
const origin = {
  headSha: "a".repeat(40),
  runId: "12",
  repository: "example/repo",
};
const current = { ...origin, headSha: "b".repeat(40), runId: "13" };
function put(root, name, value = name) {
  mkdirSync(dirname(join(root, name)), { recursive: true });
  writeFileSync(join(root, name), value);
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "frontend-artifact-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of [
    "frontend/src/page.tsx",
    "frontend/src/style.css",
    "frontend/src/locales/zh.json",
    "frontend/src/prompt.md",
    "frontend/public/icon.svg",
    "frontend/scripts/assets.mjs",
    "frontend/next.config.js",
    "frontend/tsconfig.json",
    "frontend/package.json",
    "packages/chat-core/src/index.ts",
    "packages/collaboration/src/index.ts",
    "shared/assets/data.json",
    "shared/data/collaboration-templates.json",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    "frontend/e2e/scenario.spec.ts",
    "frontend/src/page.test.tsx",
    "backend/app/main.py",
    "docs/guide.md",
    ".github/actions/build-frontend-e2e/action.yml",
    ".github/actions/setup-node-workspace/action.yml",
    ".github/scripts/frontend-e2e-build.mjs",
    ".github/scripts/archive-frontend-e2e-build.sh",
    ".github/scripts/restore-frontend-e2e-build.sh",
  ])
    put(root, name);
  put(root, ".gitignore", "frontend/public/fonts/**\nfrontend/.next/**\n");
  put(root, "frontend/public/fonts/generated.woff2", "locked-font");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  return root;
}

test("frontend keys cover complete output inputs and do not depend on Backend, tests or repository docs", (t) => {
  const root = fixture(t);
  const key = () => frontendBuild(root, "Example", context).sourceKey;
  const original = key();
  for (const name of [
    "frontend/src/page.tsx",
    "frontend/src/style.css",
    "frontend/src/locales/zh.json",
    "frontend/src/prompt.md",
    "frontend/public/icon.svg",
    "frontend/public/fonts/generated.woff2",
    "frontend/scripts/assets.mjs",
    "frontend/next.config.js",
    "frontend/tsconfig.json",
    "packages/chat-core/src/index.ts",
    "packages/collaboration/src/index.ts",
    "shared/data/collaboration-templates.json",
    "pnpm-lock.yaml",
    ".npmrc",
    ".github/actions/build-frontend-e2e/action.yml",
  ]) {
    const before = readFileSync(join(root, name));
    put(root, name, `${before}\nchanged`);
    assert.notEqual(key(), original, name);
    put(root, name, before);
  }
  for (const name of [
    "frontend/e2e/scenario.spec.ts",
    "frontend/src/page.test.tsx",
    "backend/app/main.py",
    "docs/guide.md",
  ]) {
    put(root, name, "changed outside build inputs");
    assert.equal(key(), original, name);
  }
  for (const changed of [
    { ...context, node: "v24.15.0" },
    { ...context, nodeAbi: "999" },
    { ...context, glibc: "2.40" },
    { ...context, pnpm: "12.0.0" },
    { ...context, next: "16.0.0" },
    { ...context, platform: "linux-arm64" },
    {
      ...context,
      environment: { NODE_ENV: "production", NEXT_PUBLIC_FEATURE: "enabled" },
    },
  ])
    assert.notEqual(
      frontendBuild(root, "example", changed).sourceKey,
      original,
    );
});

test("tracked file modes and symlink target bytes participate in the key", (t) => {
  const root = fixture(t);
  const file = join(root, "frontend/src/page.tsx");
  const original = frontendBuild(root, "example", context).sourceKey;
  chmodSync(file, 0o755);
  assert.notEqual(frontendBuild(root, "example", context).sourceKey, original);
  put(root, "source.txt", "first");
  symlinkSync("../../source.txt", join(root, "frontend/src/linked.ts"));
  execFileSync("git", ["add", "frontend/src/linked.ts"], { cwd: root });
  const linked = frontendBuild(root, "example", context).sourceKey;
  put(root, "source.txt", "second");
  assert.notEqual(frontendBuild(root, "example", context).sourceKey, linked);
});

test("effective locale and optional dotenv inputs invalidate reuse without exposing private configuration", (t) => {
  const root = fixture(t);
  const environment = frontendBuildEnvironment({
    NEXT_PUBLIC_API_URL: "/api",
    PRIVATE_SERVER_TOKEN: "private-test-value",
  });
  assert.equal(environment.I18N_LNG, "en");
  assert.equal(Object.hasOwn(environment, "PRIVATE_SERVER_TOKEN"), false);
  const metadata = frontendBuild(root, "example", { ...context, environment });
  const translated = frontendBuildEnvironment({
    NEXT_PUBLIC_API_URL: "/api",
    I18N_LNG: "zh-CN",
  });
  assert.notEqual(
    frontendBuild(root, "example", { ...context, environment: translated })
      .sourceKey,
    metadata.sourceKey,
  );
  for (const name of [
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local",
  ]) {
    put(
      root,
      `frontend/${name}`,
      "PRIVATE_SERVER_TOKEN=private-test-value\nNEXT_PUBLIC_API_URL=/api-other",
    );
    const changed = frontendBuild(root, "example", { ...context, environment });
    assert.notEqual(changed.sourceKey, metadata.sourceKey, name);
    put(root, archiveName, "compressed frontend");
    describeBuild(root, changed, origin, "build-id");
    assert(
      !readFileSync(join(root, manifestName), "utf8").includes(
        "private-test-value",
      ),
    );
    rmSync(join(root, `frontend/${name}`));
    assert.equal(
      frontendBuild(root, "example", { ...context, environment }).sourceKey,
      metadata.sourceKey,
    );
  }
});

test("cache attestation preserves original build identity and rejects stale current-run handoff", (t) => {
  const root = fixture(t);
  const metadata = frontendBuild(root, "example", context);
  put(root, archiveName, "complete compressed frontend");
  describeBuild(root, metadata, origin, "original-build-id");
  assert.throws(
    () => verifyBuild(root, metadata, current),
    /current producer identity/,
  );
  attestBuild(root, metadata, current, "ghcr.io/example/cache@sha256:fixed");
  const restored = verifyBuild(root, metadata, current);
  assert.deepEqual(restored.origin, origin);
  assert.deepEqual(restored.verifiedFor, current);
  assert.equal(restored.buildId, "original-build-id");
  assert.throws(
    () => verifyBuild(root, { ...metadata, sourceKey: "c".repeat(64) }),
    /input mismatch/,
  );
});

test("corrupt, missing, duplicated and mismatched frontend payloads fail closed", (t) => {
  const root = fixture(t);
  const metadata = frontendBuild(root, "example", context);
  put(root, archiveName, "complete compressed frontend");
  const manifest = describeBuild(root, metadata, origin, "build-id");
  for (const mutate of [
    (value) => {
      value.context.platform = "darwin-arm64";
    },
    (value) => {
      value.origin.headSha = "invalid";
    },
    (value) => {
      value.files.push(value.files[0]);
    },
    (value) => {
      value.files = [];
    },
    (value) => {
      value.buildId = "";
    },
  ]) {
    const changed = structuredClone(manifest);
    mutate(changed);
    put(root, manifestName, JSON.stringify(changed));
    assert.throws(() => verifyBuild(root, metadata));
  }
  put(root, manifestName, JSON.stringify(manifest));
  put(root, archiveName, "corrupted frontend");
  assert.throws(() => verifyBuild(root, metadata), /SHA256 mismatch/);
  rmSync(join(root, archiveName));
  assert.throws(() => verifyBuild(root, metadata));
});

function registry(t, change = () => {}) {
  const source = fixture(t);
  const metadata = frontendBuild(source, "example", context);
  put(source, archiveName, "complete compressed frontend");
  describeBuild(source, metadata, origin, "build-id");
  const calls = [];
  const manifest = {
    artifactType,
    layers: [archiveName, manifestName].map((name) => ({
      annotations: { "org.opencontainers.image.title": name },
    })),
  };
  const run = (args, options) => {
    calls.push(args);
    if (args[0] === "push") {
      assert.equal(options.cwd, source);
      return "";
    }
    const config = args[args.indexOf("--registry-config") + 1];
    assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { auths: {} });
    change(args, manifest);
    if (args[0] === "manifest") return JSON.stringify(manifest);
    const output = args[args.indexOf("--output") + 1];
    for (const name of [archiveName, manifestName])
      copyFileSync(join(source, name), join(output, name));
    return "";
  };
  return { source, metadata, calls, run };
}

test("OCI cache hits verify both layers anonymously and always remove temporary credentials", (t) => {
  const { source, metadata, run, calls } = registry(t);
  const output = join(source, "restored");
  assert.equal(restoreFrontendBuild(output, metadata, run), true);
  assert.deepEqual(
    verifyBuild(output, metadata),
    verifyBuild(source, metadata),
  );
  for (const args of calls)
    assert.equal(
      existsSync(args[args.indexOf("--registry-config") + 1]),
      false,
    );
});

test("OCI absence is a miss only for unpinned tags; bad manifests and transport failures are errors", (t) => {
  const { source, metadata } = registry(t);
  const output = join(source, "restored");
  const missing = () => {
    throw new Error("MANIFEST_UNKNOWN: not found");
  };
  assert.equal(restoreFrontendBuild(output, metadata, missing), false);
  assert.equal(existsSync(output), false);
  assert.throws(() =>
    restoreFrontendBuild(
      output,
      { ...metadata, restoreImage: "ghcr.io/example/cache@sha256:fixed" },
      missing,
    ),
  );
  assert.throws(
    () =>
      restoreFrontendBuild(output, metadata, () => {
        throw new Error("connection reset");
      }),
    /connection reset/,
  );
  for (const mutation of [
    (manifest) => {
      manifest.artifactType = "application/wrong";
    },
    (manifest) => {
      manifest.layers.pop();
    },
    (manifest) => {
      manifest.layers.push(manifest.layers[0]);
    },
  ]) {
    const fixture = registry(t, (_args, manifest) => mutation(manifest));
    assert.throws(() =>
      restoreFrontendBuild(output, fixture.metadata, fixture.run),
    );
    assert.equal(existsSync(output), false);
  }
  const corrupted = registry(t, (args) => {
    if (args[0] === "pull") put(corrupted.source, archiveName, "corrupt");
  });
  assert.throws(
    () => restoreFrontendBuild(output, corrupted.metadata, corrupted.run),
    /SHA256 mismatch/,
  );
});

test("frontend publication preserves an existing valid immutable build and rejects stale handoffs", (t) => {
  const { source, metadata, run, calls } = registry(t);
  publishFrontendBuild(source, metadata, origin, run);
  assert.equal(
    calls.some((args) => args[0] === "push"),
    false,
  );
  assert.throws(
    () => publishFrontendBuild(source, metadata, current, run),
    /current producer identity/,
  );
  const publish = (args, options) =>
    args[0] === "push"
      ? run(args, options)
      : (() => {
          throw new Error("manifest unknown");
        })();
  publishFrontendBuild(source, metadata, origin, publish);
  assert.equal(calls.filter((args) => args[0] === "push").length, 1);
});

test("promotion accepts only the exact successful upstream producer and validates its current attestation", async (t) => {
  const { source, metadata } = registry(t);
  const repository = "wecode-ai/Wegent";
  const identity = { ...origin, repository };
  describeBuild(source, metadata, identity, "ci-build");
  const run = {
    id: 12,
    path: ".github/workflows/e2e-tests.yml",
    repository: { full_name: repository },
    status: "completed",
    conclusion: "failure",
    head_sha: origin.headSha,
  };
  const job = {
    id: 34,
    run_id: 12,
    head_sha: origin.headSha,
    status: "completed",
    conclusion: "success",
    name: "Build Frontend E2E Artifact",
  };
  let downloaded = 0;
  const options = (sourceRun = run, producer = job) => ({
    checkoutRoot: source,
    json: async (path) =>
      path.endsWith("/jobs?per_page=100") ? { jobs: [producer] } : sourceRun,
    download: () => {
      downloaded++;
    },
  });
  const publisherContext = { ...context, glibc: "2.43" };
  assert.notEqual(
    frontendBuild(source, "example", publisherContext).sourceKey,
    metadata.sourceKey,
  );
  const result = await restoreFrontendFromCi(12, source, "example", options());
  assert.deepEqual(result.manifest.origin, identity);
  assert.deepEqual(result.metadata.context, context);
  assert.equal(result.metadata.sourceKey, metadata.sourceKey);
  assert.equal(downloaded, 1);
  for (const changed of [
    { ...run, id: 13 },
    { ...run, path: ".github/workflows/other.yml" },
    { ...run, repository: { full_name: "other/repo" } },
    { ...run, status: "in_progress" },
    { ...run, conclusion: "cancelled" },
  ])
    await assert.rejects(
      restoreFrontendFromCi(12, source, "example", options(changed)),
    );
  for (const changed of [
    { ...job, head_sha: current.headSha },
    { ...job, run_id: 13 },
    { ...job, status: "in_progress" },
    { ...job, conclusion: "failure" },
  ])
    await assert.rejects(
      restoreFrontendFromCi(12, source, "example", options(run, changed)),
    );
  assert.equal(downloaded, 1);
  const originalManifest = readFileSync(join(source, manifestName));
  put(
    source,
    manifestName,
    JSON.stringify({ ...result.manifest, context: publisherContext }),
  );
  await assert.rejects(
    restoreFrontendFromCi(12, source, "example", options()),
    /input mismatch/,
  );
  put(source, manifestName, originalManifest);
  const page = readFileSync(join(source, "frontend/src/page.tsx"));
  put(source, "frontend/src/page.tsx", "changed checkout must fail promotion");
  await assert.rejects(
    restoreFrontendFromCi(12, source, "example", options()),
    /input mismatch/,
  );
  put(source, "frontend/src/page.tsx", page);
  attestBuild(source, metadata, current);
  await assert.rejects(
    restoreFrontendFromCi(12, source, "example", options()),
    /current producer identity/,
  );
});

test("real tar/zstd round trip restores standalone, static and public files and rejects corrupt input before replacement", (t) => {
  const root = fixture(t);
  const scripts = [
    "archive-frontend-e2e-build.sh",
    "restore-frontend-e2e-build.sh",
    "frontend-e2e-build.mjs",
    "resolve-ci-image.mjs",
  ];
  for (const name of scripts)
    copyFileSync(
      fileURLToPath(new URL(name, import.meta.url)),
      join(root, ".github/scripts", name),
    );
  put(root, "frontend/.next/BUILD_ID", "real-build");
  put(
    root,
    "frontend/.next/standalone/frontend/server.js",
    "standalone server",
  );
  put(root, "frontend/.next/static/app.js", "built static");
  put(root, "frontend/.next/cache/transient", "excluded cache");
  const metadata = frontendBuild(root, "example", context);
  const artifact = join(root, ".ci-artifacts");
  execFileSync("bash", [".github/scripts/archive-frontend-e2e-build.sh"], {
    cwd: root,
    stdio: "pipe",
  });
  describeBuild(artifact, metadata, origin, "real-build");
  const env = {
    ...process.env,
    FRONTEND_HEAD_SHA: origin.headSha,
    GITHUB_RUN_ID: origin.runId,
    GITHUB_REPOSITORY: origin.repository,
  };
  put(root, "frontend/public/stale.txt", "remove stale public output");
  const restore = () =>
    execFileSync("bash", [".github/scripts/restore-frontend-e2e-build.sh"], {
      cwd: root,
      env,
      stdio: "pipe",
    });
  restore();
  assert.equal(
    readFileSync(
      join(root, "frontend/.next/standalone/frontend/.next/static/app.js"),
      "utf8",
    ),
    "built static",
  );
  assert.equal(
    readFileSync(
      join(root, "frontend/.next/standalone/frontend/public/icon.svg"),
      "utf8",
    ),
    "frontend/public/icon.svg",
  );
  assert.equal(existsSync(join(root, "frontend/.next/cache")), false);
  assert.equal(existsSync(join(root, "frontend/public/stale.txt")), false);
  put(artifact, archiveName, "not a compressed archive");
  assert.throws(restore);
  assert.equal(
    readFileSync(join(root, "frontend/.next/BUILD_ID"), "utf8"),
    "real-build",
  );
});

test("complete build reuse preserves the CI job inventory and separates read-only consumers from publication", () => {
  const yaml = (path) =>
    JSON.parse(
      execFileSync(
        "ruby",
        [
          "-ryaml",
          "-rjson",
          "-e",
          "puts JSON.generate(YAML.load_file(ARGV[0]))",
          path,
        ],
        { encoding: "utf8" },
      ),
    );
  const workflow = yaml(".github/workflows/e2e-tests.yml");
  assert.deepEqual(Object.keys(workflow.jobs), [
    "changes",
    "build-frontend-e2e",
    "prepare-platform-e2e-image",
    "build-backend-rs-e2e-runtime",
    "verify-backend-delivery-image",
    "build-executor-e2e-runtime",
    "e2e-tests",
    "executor-e2e-tests",
    "platform-e2e-summary",
  ]);
  const producer = workflow.jobs["build-frontend-e2e"];
  assert.equal(producer["runs-on"], "ubuntu-latest");
  assert.equal(producer["timeout-minutes"], 20);
  assert.deepEqual(producer.needs, "changes");
  assert(
    !Object.values(producer.permissions || workflow.permissions).includes(
      "write",
    ),
  );
  const action = producer.steps.find(
    (step) => step.uses === "./.github/actions/build-frontend-e2e",
  );
  assert.equal(action.with.publish, undefined);
  for (const name of ["e2e-tests", "executor-e2e-tests"]) {
    const restore = workflow.jobs[name].steps.find(
      (step) => step.name === "Restore frontend E2E build",
    );
    assert.equal(
      restore.env.FRONTEND_HEAD_SHA,
      "${{ github.event.pull_request.head.sha || github.sha }}",
    );
  }
  const warmup = yaml(".github/workflows/ci-cache-warmup.yml");
  assert.deepEqual(Object.keys(warmup.jobs), [
    "changes",
    "warm-node",
    "warm-python",
    "warm-executor-rust",
    "warm-wework-windows-electron",
    "warm-wework-macos-electron",
    "prepare-wework-desktop-image",
    "warm-wework-desktop-core-e2e-build",
    "warm-executor-e2e-image",
    "publish-macos-runtime-prebuilds",
  ]);
  const publisher = warmup.jobs["warm-node"];
  assert.equal(publisher.permissions.packages, "write");
  assert.equal(publisher["runs-on"], "ubuntu-latest");
  assert(publisher.if.includes("github.ref == 'refs/heads/main'"));
  assert(
    publisher.if.includes(
      "github.event_name == 'workflow_dispatch' && inputs.prebuild == 'frontend'",
    ),
  );
  const shared = publisher.steps.find(
    (step) => step.uses === "./.github/actions/build-frontend-e2e",
  );
  assert.equal(shared.with.publish, "true");
  assert.equal(
    shared.with["source-run"],
    "${{ inputs.frontend_build_source_run }}",
  );
  assert.equal(shared.with["setup-workspace"], "false");
  assert.equal(
    shared.with["save-cache"],
    "${{ github.ref == 'refs/heads/main' }}",
  );
});
