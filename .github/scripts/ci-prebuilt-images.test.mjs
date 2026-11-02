import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { prebuiltImage } from "./ci-prebuilt-images.mjs";

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
      "executor/vendor",
      "backend-rs/Cargo.toml",
      "backend-rs/Cargo.lock",
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
  for (const artifact of ["true", "false"]) {
    for (const exists of ["true", "false"]) {
      const steps = {
        access: { outputs: { artifact } },
        "image-check": { outputs: { exists } },
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
      assert.equal(enabled("Check content-addressed Executor E2E image"), true);
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
      assert.equal(
        enabled("Archive fork Executor E2E runtime"),
        artifact === "true",
      );
      assert.equal(enabled("Log in to GHCR"), artifact !== "true");
    }
  }
});

test("prebuild publication is limited to main and explicit manual dispatches", () => {
  const publisher = workflow("ci-cache-warmup").jobs["warm-executor-e2e-image"];
  const needs = { changes: { result: "success", outputs: { docker: "true" } } };
  for (const event_name of ["pull_request", "push", "workflow_dispatch"]) {
    for (const ref of ["refs/heads/main", "refs/heads/topic"]) {
      const enabled = runInNewContext(publisher.if, {
        github: { event_name, ref },
        needs,
        always: () => true,
      });
      assert.equal(
        enabled,
        event_name === "workflow_dispatch" ||
          (event_name === "push" && ref === "refs/heads/main"),
      );
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
