import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  deduplicateCodex,
  materializeCodex,
} from "./wework-core-e2e-transport.mjs";

const scripts = resolve(".github/scripts");
const target = "x86_64-unknown-linux-gnu";
const executable = "vendor/x86_64-unknown-linux-musl/bin/codex";
function write(path, contents, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  chmodSync(path, mode);
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "wework-e2e-transport-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const build = join(root, "wework-core-e2e-build");
  const packaged = join(build, "electron-app/resources/codex");
  const external = join(build, "codex", target);
  write(join(packaged, executable), randomBytes(128 * 1024), 0o755);
  write(join(packaged, "metadata.json"), '{"version":"locked"}\n');
  cpSync(packaged, external, { recursive: true });
  return { root, build, packaged, external };
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result;
}

test("only identical regular files with matching modes share transport data", async (t) => {
  const { build, packaged, external } = fixture(t);
  write(join(packaged, "different"), "one");
  write(join(external, "different"), "two");
  write(join(packaged, "mode"), "same", 0o755);
  write(join(external, "mode"), "same", 0o644);
  write(join(external, "external-only"), "preserved");
  symlinkSync(executable, join(external, "link"));
  const result = await deduplicateCodex(build);
  assert.equal(result.files, 2);
  assert.equal(
    result.bytes,
    128 * 1024 + Buffer.byteLength('{"version":"locked"}\n'),
  );
  assert.equal(
    lstatSync(join(packaged, executable)).ino,
    lstatSync(join(external, executable)).ino,
  );
  for (const name of ["different", "mode"]) {
    assert.notEqual(
      lstatSync(join(packaged, name)).ino,
      lstatSync(join(external, name)).ino,
    );
  }
  assert.equal(
    readFileSync(join(external, "external-only"), "utf8"),
    "preserved",
  );
  assert(lstatSync(join(external, "link")).isSymbolicLink());
});

test("materialization preserves bytes and modes while isolating in-place mutations", async (t) => {
  const { build, packaged, external } = fixture(t);
  const expected = readFileSync(join(packaged, executable));
  await deduplicateCodex(build);
  materializeCodex(build);
  assert.deepEqual(readFileSync(join(external, executable)), expected);
  assert.equal(lstatSync(join(external, executable)).mode & 0o777, 0o755);
  assert.notEqual(
    lstatSync(join(packaged, executable)).ino,
    lstatSync(join(external, executable)).ino,
  );
  assert.equal(lstatSync(join(external, executable)).nlink, 1);
  writeFileSync(join(external, executable), "changed external runtime");
  assert.deepEqual(readFileSync(join(packaged, executable)), expected);
  materializeCodex(build);
  assert.equal(
    readFileSync(join(external, executable), "utf8"),
    "changed external runtime",
  );
});

test("symbolic-link Codex roots are rejected before changing any files", async (t) => {
  const { build, external } = fixture(t);
  const moved = `${external}-actual`;
  cpSync(external, moved, { recursive: true });
  rmSync(external, { recursive: true });
  symlinkSync(moved, external);
  await assert.rejects(deduplicateCodex(build), /Expected directory/);
  assert.throws(() => materializeCodex(build), /Expected directory/);
});

test("the real archive and restore scripts round-trip every Codex file independently", (t) => {
  const { root, packaged } = fixture(t);
  const repo = join(root, "repo");
  const app = join(repo, "wework/electron/release/WeWork-linux-x64");
  const source = join(repo, "wework/resources/binaries/codex", target);
  cpSync(packaged, join(app, "resources/codex"), { recursive: true });
  cpSync(packaged, source, { recursive: true });
  for (const path of ["WeWork", "resources/bin/wegent-executor"])
    write(join(app, path), path, 0o755);
  write(join(app, "resources/components.json"), "{}");
  const payload = join(root, "runtime-payload");
  write(join(payload, "fixture.json"), '{"packaged":true}\n');
  const runtimeArchives = [
    "wework-core-plugins.tar.gz",
    "wework-app-static.tar.gz",
    "bundled-plugins.tar.gz",
  ];
  for (const name of runtimeArchives)
    run("tar", ["-czf", join(app, "resources", name), "-C", payload, "."]);
  write(
    join(app, "resources/harness-runtime/runtime.tar.gz"),
    "managed runtime",
  );
  write(join(repo, ".ci-artifacts/wegent-backend-rs"), "backend", 0o755);
  write(
    join(repo, "wework/scripts/build-desktop-e2e-client.mjs"),
    `
import { mkdirSync, writeFileSync } from 'node:fs'
mkdirSync(process.argv[2], { recursive: true })
for (const name of ['socket.io-client.cjs', 'lz-string.cjs', 'yaml.cjs'])
  writeFileSync(process.argv[2] + '/' + name, 'client module')
`,
  );
  mkdirSync(join(repo, ".github/scripts"), { recursive: true });
  copyFileSync(
    join(scripts, "wework-core-e2e-transport.mjs"),
    join(repo, ".github/scripts/wework-core-e2e-transport.mjs"),
  );
  // Script fixtures are not executable images; only strip is replaced, never tar or zstd.
  write(join(root, "bin/strip"), "#!/usr/bin/env bash\nexit 0\n", 0o755);
  const options = {
    cwd: repo,
    env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` },
  };
  const expected = readFileSync(join(source, executable));
  const archived = run(
    "bash",
    [join(scripts, "archive-wework-core-e2e-build.sh")],
    options,
  );
  assert.match(archived.stdout, /transport-deduplicate files=2 bytes=/);
  const archive = join(repo, ".ci-artifacts/wework-core-e2e-build.tar.zst");
  const raw = join(root, "raw");
  mkdirSync(raw);
  run("bash", [
    "-o",
    "pipefail",
    "-c",
    'zstd -dc "$1" | tar -xf - -C "$2"',
    "extract",
    archive,
    raw,
  ]);
  const rawApp = join(
    raw,
    "wework-core-e2e-build/electron-app/resources/codex",
    executable,
  );
  const rawCli = join(raw, "wework-core-e2e-build/codex", target, executable);
  assert.equal(lstatSync(rawApp).ino, lstatSync(rawCli).ino);
  run("bash", [join(scripts, "restore-wework-core-e2e-build.sh")], options);
  const restored = join(repo, ".ci-artifacts/wework-core-e2e-build");
  for (const name of runtimeArchives)
    assert.deepEqual(
      readFileSync(join(restored, "electron-app/resources", name)),
      readFileSync(join(app, "resources", name)),
    );
  const restoredApp = join(
    restored,
    "electron-app/resources/codex",
    executable,
  );
  const restoredCli = join(restored, "codex", target, executable);
  assert.deepEqual(readFileSync(restoredApp), expected);
  assert.deepEqual(readFileSync(restoredCli), expected);
  assert.equal(lstatSync(restoredCli).mode & 0o777, 0o755);
  assert.notEqual(lstatSync(restoredApp).ino, lstatSync(restoredCli).ino);
  writeFileSync(restoredCli, "updated");
  assert.deepEqual(readFileSync(restoredApp), expected);
  assert.deepEqual(readFileSync(join(source, executable)), expected);
  assert.deepEqual(
    readFileSync(join(app, "resources/codex", executable)),
    expected,
  );
  writeFileSync(archive, "truncated archive");
  const broken = spawnSync(
    "bash",
    [join(scripts, "restore-wework-core-e2e-build.sh")],
    options,
  );
  assert.notEqual(broken.status, 0);
});
