import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runtimeArtifact } from "./runtime-artifact.mjs";

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
