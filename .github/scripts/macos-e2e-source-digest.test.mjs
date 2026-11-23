import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const script = resolve(".github/scripts/macos-e2e-source-digest.mjs");
// These old keys omitted embedded non-Rust inputs and must never be reused.
const incompleteDigests = {
  executor: "478cef69916aab797fe26d54ab1fef757ee71e67ac3150cb63689bfc08b61253",
  "backend-rs":
    "7ef5c940b3282003f65044c929ee7c0a61853fb2e32b82262cc96363f5b48973",
};

for (const component of Object.keys(incompleteDigests)) {
  test(`${component} hashes embedded sources and the native build recipe`, () => {
    const root = mkdtempSync(join(tmpdir(), "macos-source-digest-"));
    const source = component === "executor" ? "src" : "be-server/src";
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
        [`${source}/main.rs`]: "fn main() {}\n",
        [`${source}/a.rs`]: "mod a;\n",
        [`${source}/a/inner.rs`]: "pub fn nested() {}\n",
        [`${source}/.hidden.rs`]: "pub fn hidden() {}\n",
        [`${source}/schema.json`]: '{"type":"object"}\n',
        ...(component === "executor"
          ? {
              "crates/library/src/lib.rs": "pub fn library() {}\n",
              "vendor/dep/Cargo.toml": '[package]\nname = "dep"\n',
              "vendor/dep/src/lib.rs": "pub fn dep() {}\n",
              "vendor/dep/README.md": "Vendored documentation\n",
              "vendor/dep.bin": "Vendored binary input\n",
            }
          : {
              "be-server/Cargo.toml": '[package]\nname = "server"\n',
              "library/Cargo.toml": '[package]\nname = "library"\n',
              "library/src/lib.rs": "pub fn library() {}\n",
              "migrations/schema.json": '{"revision":"fixture"}\n',
              "src/task_export_docx/templates/thumbnail.jpeg": "thumbnail input",
            }),
      };
      for (const [path, content] of Object.entries(inputs))
        write(path, content);
      mkdirSync(join(root, ".github/ci"), { recursive: true });
      mkdirSync(join(root, ".github/actions/setup-rust-cache"), {
        recursive: true,
      });
      writeFileSync(join(root, ".github/ci/rust-toolchain"), "1.99.1\n");
      writeFileSync(
        join(root, ".github/actions/setup-rust-cache/action.yml"),
        "shared rust cache recipe\n",
      );
      mkdirSync(join(root, ".github/scripts"), { recursive: true });
      const contextInputs = {
        "shared/rust/crypto/src/lib.rs": "pub fn shared_crypto() {}\n",
        "shared/assets/calendars/china-workdays.json": '{"workdays":[]}\n',
        "shared/assets/calendars/LICENSE.chinesecalendar": "MIT license\n",
        ".github/scripts/build-macos-e2e-runtimes.sh": "cargo build --locked\n",
        ...(component === "executor"
          ? {
              "sdk/plugin-auth/auth.ts": "export const auth = true\n",
              "sdk/plugin-creator/README.md": "Embedded SDK guide\n",
              "shared/assets/instructions.md": "Embedded instructions\n",
              "shared/protocol/runtime_task_create_request_v2.schema.json":
                '{"type":"object"}\n',
            }
          : {
              "shared/assets/codex-models/openai.json": "Embedded models",
              "shared/data/builtin-connector-apps.json": "Embedded connectors",
            }),
      };
      for (const [file, content] of Object.entries(contextInputs)) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), content);
      }
      execFileSync("git", ["init", "-q"], { cwd: root });
      stage();
      const original = digest();
      assert.equal(digest(), original);
      write(`${source}/schema.json`, '{"type":"string"}\n');
      assert.notEqual(
        digest(),
        original,
        "embedded JSON must invalidate the binary",
      );
      write(`${source}/schema.json`, inputs[`${source}/schema.json`]);
      assert.notEqual(original, incompleteDigests[component]);

      for (const [file, content] of [
        [".github/ci/rust-toolchain", "1.99.1\n"],
        [
          ".github/actions/setup-rust-cache/action.yml",
          "shared rust cache recipe\n",
        ],
      ]) {
        writeFileSync(join(root, file), "changed build context\n");
        assert.notEqual(digest(), original);
        writeFileSync(join(root, file), content);
      }
      for (const [file, content] of Object.entries(contextInputs)) {
        writeFileSync(join(root, file), "Changed embedded source or recipe\n");
        assert.notEqual(digest(), original, file);
        writeFileSync(join(root, file), content);
      }
      write("target/untracked.rs", "Ignored build output\n");
      assert.equal(digest(), original);

      for (const path of [
        "Cargo.toml",
        "Cargo.lock",
        `${source}/a/inner.rs`,
        `${source}/schema.json`,
        ...(component === "executor"
          ? ["vendor/dep/README.md"]
          : [
              "library/Cargo.toml",
              "library/src/lib.rs",
              "migrations/schema.json",
              "src/task_export_docx/templates/thumbnail.jpeg",
            ]),
      ]) {
        write(path, "Changed input\n");
        assert.notEqual(digest(), original, path);
        write(path, inputs[path]);
      }
      write(`${source}/new.rs`, "pub fn added() {}\n");
      stage();
      const withAddition = digest();
      assert.notEqual(withAddition, original);
      rmSync(join(root, component, `${source}/new.rs`));
      stage();
      assert.equal(digest(), original);

      execFileSync(
        "git",
        ["mv", `${component}/${source}/schema.json`, `${component}/${source}/renamed.json`],
        { cwd: root },
      );
      assert.notEqual(digest(), original, "file paths are build inputs");

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
