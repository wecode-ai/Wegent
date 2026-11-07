import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { prebuiltImage } from "./ci-prebuilt-images.mjs";
import { runtimeArtifact } from "./runtime-artifact.mjs";

const root = new URL("../../", import.meta.url);
const pinnedBase = `ghcr.io/example/base@sha256:${"a".repeat(64)}`;

test("dependency keys follow build inputs and survive application-only changes", () => {
  const directory = mkdtempSync(join(tmpdir(), "wegent-ci-images-"));
  try {
    for (const input of [
      ".github/ci/rust-toolchain",
      ".github/runtime-images/backend-rs-builder.Dockerfile",
      "frontend/e2e/fixtures/claudecode-executor/Dockerfile",
      "executor/Cargo.toml",
      "executor/Cargo.lock",
      "executor/crates",
      "executor/vendor",
      "shared/rust",
      "shared/assets",
      "sdk/plugin-creator",
      "sdk/plugin-auth",
      "backend-rs/Cargo.toml",
      "backend-rs/Cargo.lock",
      "backend-rs/crates",
    ]) {
      mkdirSync(dirname(join(directory, input)), { recursive: true });
      cpSync(new URL(input, root), join(directory, input), { recursive: true });
    }
    const key = (kind = "executor-deps", base = pinnedBase) =>
      prebuiltImage(kind, "Example", base, directory).image;
    const executor = key();
    const backend = key("backend-rs-deps");
    mkdirSync(join(directory, "executor/src"), { recursive: true });
    writeFileSync(
      join(directory, "executor/src/new.rs"),
      "application changes",
    );
    assert.equal(key(), executor);
    const sharedSource = join(directory, "shared/rust/crypto/src/lib.rs");
    const originalSource = readFileSync(sharedSource, "utf8");
    writeFileSync(
      sharedSource,
      `${originalSource}\n// Changed shared algorithm\n`,
    );
    assert.notEqual(key(), executor);
    assert.notEqual(key("backend-rs-deps"), backend);
    writeFileSync(sharedSource, originalSource);
    for (const input of [
      "shared/assets/codexProgressiveInstructions.md",
      "shared/assets/codexDiscoveryInstructions.md",
      "sdk/plugin-auth/tool.py",
      "sdk/plugin-creator/SKILL.md",
    ]) {
      const source = join(directory, input);
      const original = readFileSync(source, "utf8");
      writeFileSync(source, `${original}\nChanged embedded build input\n`);
      assert.notEqual(key(), executor, `${input} must invalidate compiled libraries`);
      assert.equal(key("backend-rs-deps"), backend);
      writeFileSync(source, original);
    }
    writeFileSync(
      join(directory, "executor/Cargo.lock"),
      "changed dependencies",
    );
    assert.notEqual(key(), executor);
    assert.equal(key("backend-rs-deps"), backend);
    writeFileSync(join(directory, ".github/ci/rust-toolchain"), "1.99.2");
    assert.notEqual(key("backend-rs-deps"), backend);
    assert.notEqual(
      key(),
      key("executor-deps", pinnedBase.replace(/a{64}$/, "b".repeat(64))),
    );
    assert.throws(() => key("executor-deps", "base:latest"), /immutable/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function workflow(name) {
  return JSON.parse(
    execFileSync(
      "ruby",
      [
        "-ryaml",
        "-rjson",
        "-e",
        "puts JSON.generate(YAML.load_file(ARGV[0]))",
        `.github/workflows/${name}.yml`,
      ],
      { cwd: root, encoding: "utf8" },
    ),
  );
}

test("publication normalizes registry caches and manual seeds cannot overwrite shared caches", () => {
  const directory = mkdtempSync(join(tmpdir(), "wegent-ci-publisher-"));
  try {
    const docker = join(directory, "docker");
    writeFileSync(
      docker,
      '#!/usr/bin/env bash\nset -euo pipefail\nprintf "%s\\n" "$*" >> "$TEST_DOCKER_LOG"\nif [[ "$1 $2" == "buildx imagetools" ]]; then exit 1; fi\n',
    );
    chmodSync(docker, 0o755);
    for (const ref of ["refs/heads/main", "refs/heads/topic"]) {
      const log = join(
        directory,
        ref.endsWith("main") ? "main.log" : "manual.log",
      );
      const result = spawnSync(
        "bash",
        [".github/scripts/publish-ci-prebuild.sh", "executor"],
        {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            GITHUB_REPOSITORY_OWNER: "Example",
            GITHUB_REPOSITORY: "Example/Wegent",
            GITHUB_REF: ref,
            BASE_IMAGE: pinnedBase,
            RUNTIME_IMAGE: "ghcr.io/example/runtime:test",
            EXECUTOR_BUILD_CACHE:
              "ghcr.io/Example/wegent-executor:buildcache-e2e",
            TEST_DOCKER_LOG: log,
          },
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const calls = readFileSync(log, "utf8").split("\n");
      const builds = calls.filter((line) => line.startsWith("buildx build "));
      assert.equal(builds.length, 2);
      for (const build of builds) {
        assert.ok(
          build.includes(
            "--cache-from type=registry,ref=ghcr.io/example/wegent-executor:buildcache-e2e",
          ),
        );
        assert.equal(build.includes("--cache-to"), ref === "refs/heads/main");
      }
      assert.equal(calls.filter((line) => line.startsWith("push ")).length, 2);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fork and trusted PRs reuse image hits while missing images build exactly once", () => {
  const producer = workflow("e2e-tests").jobs["build-executor-e2e-runtime"];
  const transport = producer.steps.find((step) => step.id === "transport");
  assert.equal(
    producer.outputs.artifact,
    "${{ steps.transport.outputs.artifact }}",
  );
  assert.equal(
    producer.steps.find((step) => step.name === "Upload Executor E2E binary")
      .if,
    undefined,
  );
  for (const artifact of ["true", "false"]) {
    for (const exists of ["true", "false"]) {
      for (const pinned of [true, false]) {
        const directory = mkdtempSync(
          join(tmpdir(), "executor-image-transport-"),
        );
        const output = join(directory, "output");
        const result = spawnSync("bash", ["-e", "-c", transport.run], {
          encoding: "utf8",
          env: {
            ...process.env,
            FORK_ARTIFACT: artifact,
            IMAGE: pinned
              ? `ghcr.io/example/executor@sha256:${"a".repeat(64)}`
              : "ghcr.io/example/executor:source",
            GITHUB_OUTPUT: output,
          },
        });
        assert.equal(result.status, 0, result.stderr);
        const archive = artifact === "true" && !pinned;
        assert.equal(readFileSync(output, "utf8"), `artifact=${archive}\n`);
        rmSync(directory, { recursive: true, force: true });
        const steps = {
          access: { outputs: { artifact } },
          "image-check": { outputs: { exists } },
          transport: { outputs: { artifact: String(archive) } },
        };
        const enabled = (name) => {
          const step = producer.steps.find((item) => item.name === name);
          assert.ok(step, name);
          return step.if
            ? runInNewContext(
                step.if.replaceAll("steps.image-check", 'steps["image-check"]'),
                { steps },
              )
            : true;
        };
        assert.equal(
          enabled("Check content-addressed Executor E2E image"),
          true,
        );
        assert.equal(
          enabled("Build fork Executor E2E image"),
          artifact === "true" && exists !== "true",
        );
        assert.equal(
          enabled("Build and publish Executor E2E image"),
          artifact !== "true" && exists !== "true",
        );
        assert.equal(
          enabled("Restore published fork Executor runtime"),
          artifact === "true" && exists === "true",
        );
        assert.equal(enabled("Archive fork Executor E2E runtime"), archive);
        assert.equal(enabled("Upload fork Executor E2E runtime"), archive);
        assert.equal(enabled("Log in to GHCR"), artifact !== "true");
      }
    }
  }
});

test("Executor consumers pull public pins anonymously and propagate either image pull failure", () => {
  const consumer = workflow("e2e-tests").jobs["executor-e2e-tests"];
  const pull = consumer.steps.find((step) => step.name === "Pull E2E images");
  const verification = consumer.steps.find((step) =>
    step.name.startsWith("Verify Executor E2E image against"),
  );
  assert.equal(verification.if, undefined);
  assert.match(verification.run, /verify-executor-e2e-image\.sh/);
  const binary = consumer.steps.find(
    (step) => step.name === "Download Executor E2E binary",
  );
  assert.match(binary.run, /runtime-artifact\.mjs verify/);

  const directory = mkdtempSync(join(tmpdir(), "executor-image-pull-"));
  try {
    const docker = join(directory, "docker");
    writeFileSync(
      docker,
      `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
const config = args[0] === '--config' ? args[1] : undefined
appendFileSync(process.env.TEST_DOCKER_LOG, JSON.stringify({ args, config: config ? JSON.parse(readFileSync(config + '/config.json')) : undefined }) + '\\n')
const image = args.at(-1)
if (image.includes(process.env.TEST_PULL_FAILURE || 'no-failure')) process.exit(37)
`,
    );
    chmodSync(docker, 0o755);
    const log = join(directory, "docker.log");
    const run = (archive, pinned, failure = "") => {
      writeFileSync(log, "");
      const result = spawnSync("bash", ["-e", "-c", pull.run], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          TMPDIR: directory,
          PLATFORM_E2E_IMAGE: "ghcr.io/example/platform:source",
          EXECUTOR_E2E_IMAGE: pinned
            ? pinnedBase
            : "ghcr.io/example/executor:source",
          USE_EXECUTOR_ARTIFACT: String(archive),
          TEST_DOCKER_LOG: log,
          TEST_PULL_FAILURE: failure,
        },
      });
      const calls = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.equal(result.status, failure ? 37 : 0, result.stderr);
      for (const call of calls) {
        if (call.args[0] === "--config") {
          assert.deepEqual(call.config, { auths: {} });
          assert.equal(
            existsSync(call.args[1]),
            false,
            "anonymous config must be removed",
          );
        }
      }
      return calls;
    };
    for (const archive of [false, true]) {
      for (const pinned of [false, true]) {
        const calls = run(archive, pinned);
        assert.equal(calls.length, archive ? 1 : 2);
        assert.deepEqual(
          calls.find((call) => call.args.at(-1).includes("platform")).args,
          ["pull", "ghcr.io/example/platform:source"],
        );
        if (!archive) {
          const executor = calls.find(
            (call) => !call.args.at(-1).includes("platform"),
          );
          assert.equal(executor.args[0], pinned ? "--config" : "pull");
        }
      }
    }
    run(false, true, "platform");
    run(false, true, "base");
    run(false, false, "executor");
    run(true, true, "platform");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Executor image payload must match the same-head runtime manifest and always cleans up", () => {
  const directory = mkdtempSync(join(tmpdir(), "executor-image-verify-"));
  try {
    const bin = join(directory, "bin");
    const scratch = join(directory, "scratch");
    const artifact = join(directory, "artifact");
    for (const path of [bin, scratch, artifact]) mkdirSync(path);
    const expected = join(artifact, "wegent-executor");
    const corrupt = join(directory, "corrupt");
    writeFileSync(expected, "same-head executable bytes");
    writeFileSync(corrupt, "different image payload");
    const head = "b".repeat(40);
    runtimeArtifact(
      "create",
      artifact,
      "executor",
      pinnedBase,
      ["wegent-executor"],
      head,
    );
    const log = join(directory, "docker.log");
    const docker = join(bin, "docker");
    writeFileSync(
      docker,
      `#!${process.execPath}
import { appendFileSync, copyFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.TEST_DOCKER_LOG, JSON.stringify(args) + '\\n')
if (args[0] === process.env.TEST_DOCKER_FAILURE) process.exit(38)
if (args[0] === 'create') process.stdout.write('test-container\\n')
else if (args[0] === 'cp') {
  if (args[1] !== 'test-container:/app/executor') process.exit(39)
  copyFileSync(process.env.TEST_BINARY, args[2])
} else if (args[0] !== 'rm') process.exit(40)
`,
    );
    chmodSync(docker, 0o755);
    const run = ({
      image = pinnedBase,
      source = pinnedBase,
      sha = head,
      binary = expected,
      failure = "",
    } = {}) => {
      writeFileSync(log, "");
      const result = spawnSync(
        "bash",
        [
          ".github/scripts/verify-executor-e2e-image.sh",
          image,
          source,
          artifact,
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            TMPDIR: scratch,
            RUNTIME_HEAD_SHA: sha,
            TEST_BINARY: binary,
            TEST_DOCKER_LOG: log,
            TEST_DOCKER_FAILURE: failure,
          },
        },
      );
      const calls = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.deepEqual(calls[0], ["create", image]);
      if (failure !== "create")
        assert.deepEqual(calls.at(-1), ["rm", "-f", "test-container"]);
      assert.deepEqual(
        readdirSync(scratch),
        [],
        "temporary image payload must be removed",
      );
      return result;
    };
    assert.equal(run().status, 0);
    assert.equal(
      run({ image: "wegent/e2e-claudecode-executor:latest" }).status,
      0,
    );
    const corrupted = run({ binary: corrupt });
    assert.notEqual(corrupted.status, 0);
    assert.match(corrupted.stderr, /checksum mismatch/);
    const wrongHead = run({ sha: "c".repeat(40) });
    assert.notEqual(wrongHead.status, 0);
    assert.match(wrongHead.stderr, /headSha mismatch/);
    const wrongSource = run({ source: "ghcr.io/example/other:source" });
    assert.notEqual(wrongSource.status, 0);
    assert.match(wrongSource.stderr, /sourceRef mismatch/);
    for (const failure of ["create", "cp", "rm"])
      assert.notEqual(run({ failure }).status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prebuild publication is limited to main and explicit manual dispatches", () => {
  const publisher = workflow("ci-cache-warmup").jobs["warm-executor-e2e-image"];
  const needs = { changes: { result: "success", outputs: { docker: "true" } } };
  for (const event_name of ["pull_request", "push", "workflow_dispatch"]) {
    for (const ref of ["refs/heads/main", "refs/heads/topic"]) {
      for (const prebuild of ["linux", "macos-runtimes", "frontend"]) {
        const enabled = runInNewContext(publisher.if, {
          github: { event_name, ref },
          inputs: { prebuild },
          needs,
          always: () => true,
        });
        assert.equal(
          enabled,
          (event_name === "workflow_dispatch" && prebuild === "linux") ||
            (event_name === "push" && ref === "refs/heads/main"),
        );
        const native =
          workflow("ci-cache-warmup").jobs["publish-macos-runtime-prebuilds"];
        assert.equal(
          runInNewContext(native.if, {
            github: { event_name, ref },
            inputs: { prebuild },
          }),
          event_name === "workflow_dispatch" && prebuild === "macos-runtimes",
        );
      }
    }
  }
  assert.deepEqual(publisher.strategy.matrix.component, [
    "executor",
    "backend-rs",
    "downloads",
  ]);
  const downloads = readFileSync(
    new URL("../runtime-images/ci-downloads.Dockerfile", import.meta.url),
    "utf8",
  );
  assert.match(
    downloads,
    /go install github.com\/minio\/minio@9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a/,
  );
  assert.match(downloads, /prepareSharedElectronZip/);
  assert.match(downloads, /codex-binaries.lock.json/);
});

test("native CI promotion uses the existing publisher on Linux without rebuilding Rust", () => {
  const job =
    workflow("ci-cache-warmup").jobs["publish-macos-runtime-prebuilds"];
  const rust = job.steps.find(
    (step) => step.uses === "./.github/actions/setup-rust-cache",
  );
  const build = job.steps.find(
    (step) => step.name === "Restore or build native runtime prebuilds",
  );
  const restore = job.steps.find(
    (step) => step.name === "Restore verified native runtimes from CI",
  );
  assert.equal(job.permissions.actions, "read");
  assert.equal(job.permissions.packages, "write");
  assert.equal(
    restore.env.SOURCE_RUN,
    "${{ inputs.macos_runtime_source_run }}",
  );
  assert.match(restore.run, /restore-macos-ci-runtimes.mjs "\$SOURCE_RUN"/);
  for (const source of ["", "41521135983"]) {
    const context = { inputs: { macos_runtime_source_run: source } };
    assert.equal(
      runInNewContext(job["runs-on"].slice(3, -2), context),
      source ? "ubuntu-latest" : "macos-15",
    );
    for (const step of [rust, build])
      assert.equal(runInNewContext(step.if, context), !source);
    assert.equal(runInNewContext(restore.if, context), Boolean(source));
  }
});

test("download bundles are restored once and reject unexpected archive paths", () => {
  const directory = mkdtempSync(join(tmpdir(), "wegent-ci-downloads-"));
  try {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const executable = (path, content) => {
      writeFileSync(
        path,
        `#!/usr/bin/env bash\nset -euo pipefail\n${content}\n`,
      );
      chmodSync(path, 0o755);
    };
    for (const input of [
      ".github/scripts/ci-prebuilt-images.mjs",
      ".github/scripts/resolve-ci-image.mjs",
      ".github/scripts/restore-ci-downloads.sh",
      ".github/runtime-images/ci-downloads.Dockerfile",
      "wework/electron/package.json",
      "wework/electron/pnpm-lock.yaml",
      "wework/codex-binaries.lock.json",
      "LICENSES/Apache-2.0.txt",
      "wework/third_party/codex/NOTICE",
      "wework/third_party/codex/RATATUI-LICENSE.txt",
      "wework/scripts/prepare-codex-binary.mjs",
      "wework/scripts/lib/process-lock.mjs",
      "wework/scripts/lib/electron-zip-cache.mjs",
    ]) {
      mkdirSync(dirname(join(directory, input)), { recursive: true });
      cpSync(new URL(input, root), join(directory, input));
    }
    for (const entry of ["codex", "electron-zips", "minio"])
      mkdirSync(join(directory, "payload", entry), { recursive: true });
    executable(join(directory, "payload/minio/minio"), 'test "$1" = --version');
    writeFileSync(
      join(directory, "payload/codex/locked.tgz"),
      "verified by Codex consumer",
    );
    const archive = join(directory, "downloads.tar.gz");
    execFileSync("tar", [
      "-czf",
      archive,
      "-C",
      join(directory, "payload"),
      "codex",
      "electron-zips",
      "minio",
    ]);
    executable(join(bin, "skopeo"), 'test "$TEST_IMAGE_EXISTS" = true');
    executable(
      join(bin, "tar"),
      'if [[ "$1" == -tzf && "$TEST_UNSAFE" == true ]]; then echo ../unsafe; else exec /usr/bin/tar "$@"; fi',
    );
    executable(
      join(directory, ".github/scripts/restore-oci-runtime-binary.sh"),
      'test -z "$GITHUB_TOKEN$GITHUB_ACTOR"\ncp "$TEST_ARCHIVE" "$3"\necho restored >> "$TEST_RESTORE_LOG"',
    );
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY_OWNER: "example",
      GITHUB_TOKEN: "synthetic-read-token",
      GITHUB_ACTOR: "fork-author",
      WEWORK_CI_DOWNLOAD_CACHE_DIR: join(directory, "cache"),
      RUNNER_TEMP: join(directory, "runner"),
      TEST_IMAGE_EXISTS: "true",
      TEST_UNSAFE: "false",
      TEST_ARCHIVE: archive,
      TEST_RESTORE_LOG: join(directory, "restore.log"),
    };
    const run = (overrides) =>
      spawnSync("bash", [".github/scripts/restore-ci-downloads.sh"], {
        cwd: directory,
        env: { ...env, ...overrides },
        encoding: "utf8",
      });
    assert.equal(run({ TEST_IMAGE_EXISTS: "false" }).status, 0);
    assert.equal(existsSync(env.TEST_RESTORE_LOG), false);
    const success = run({});
    assert.equal(success.status, 0, success.stderr);
    assert.ok(existsSync(join(env.RUNNER_TEMP, "wework-minio/bin/minio")));
    assert.equal(run({}).status, 0);
    assert.equal(readFileSync(env.TEST_RESTORE_LOG, "utf8"), "restored\n");
    const unsafe = run({
      TEST_UNSAFE: "true",
      WEWORK_CI_DOWNLOAD_CACHE_DIR: join(directory, "unsafe-cache"),
    });
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /unexpected path/);
    assert.equal(
      existsSync(join(directory, "unsafe-cache/ci-downloads-image")),
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
