import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const script = resolve(".github/scripts/macos-e2e-source-digest.mjs");
// Generated with @actions/glob 0.5.0 hashFiles using the workflow's patterns.
const compatibleDigests = {
  executor: "20de4ea4a8bbab5dceb3a5be72a5a28140fabfcfff1d208a0b8b6d149033b58f",
  "backend-rs":
    "627e6d439866c93e892400d1181d3da9f7f88f8b3a4f01c51a795f24f96ab834",
};

for (const component of Object.keys(compatibleDigests)) {
  test(`${component} preserves cache digests and invalidates changed inputs`, () => {
    const root = mkdtempSync(join(tmpdir(), "macos-source-digest-"));
    const write = (relative, content) => {
      const path = join(root, component, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    };
    const digest = () =>
      execFileSync(process.execPath, [script, component], {
        cwd: root,
        encoding: "utf8",
      }).trim();
    const stage = () => execFileSync("git", ["add", "."], { cwd: root });
    try {
      const inputs = {
        "Cargo.toml": '[package]\nname = "fixture"\n',
        "Cargo.lock": "version = 4\n",
        "src/main.rs": "fn main() {}\n",
        "src/a.rs": "mod a;\n",
        "src/a/inner.rs": "pub fn nested() {}\n",
        "src/.hidden.rs": "pub fn hidden() {}\n",
        "src/notes.md": "Ignored documentation\n",
        ...(component === "executor"
          ? {
              "vendor/dep/Cargo.toml": '[package]\nname = "dep"\n',
              "vendor/dep/src/lib.rs": "pub fn dep() {}\n",
              "vendor/dep/README.md": "Vendored documentation\n",
              "vendor/dep.bin": "Vendored binary input\n",
            }
          : {}),
      };
      for (const [path, content] of Object.entries(inputs))
        write(path, content);
      execFileSync("git", ["init", "-q"], { cwd: root });
      stage();
      const original = digest();
      assert.equal(original, compatibleDigests[component]);

      write("src/notes.md", "Changed non-Rust documentation\n");
      write("target/untracked.rs", "Ignored build output\n");
      assert.equal(digest(), original);

      for (const path of [
        "Cargo.toml",
        "Cargo.lock",
        "src/a/inner.rs",
        ...(component === "executor" ? ["vendor/dep/README.md"] : []),
      ]) {
        write(path, "Changed input\n");
        assert.notEqual(digest(), original, path);
        write(path, inputs[path]);
      }
      write("src/new.rs", "pub fn added() {}\n");
      stage();
      const withAddition = digest();
      assert.notEqual(withAddition, original);
      rmSync(join(root, component, "src/new.rs"));
      stage();
      assert.equal(digest(), original);

      rmSync(join(root, component, "Cargo.lock"));
      const missing = spawnSync(process.execPath, [script, component], {
        cwd: root,
        encoding: "utf8",
      });
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /ENOENT/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
