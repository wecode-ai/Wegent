import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveCiImage } from "./resolve-ci-image.mjs";

test("checked-in image seeds contain immutable references and build provenance", () => {
  const file = new URL("../ci/prebuilt-images.json", import.meta.url);
  const { images } = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(Object.keys(images).length >= 5);
  for (const [reference, entry] of Object.entries(images)) {
    assert.equal(resolveCiImage(reference), entry.image);
  }
});

test("immutable public seeds only match identical build input keys", () => {
  const directory = mkdtempSync(join(tmpdir(), "wegent-ci-seeds-"));
  try {
    const requested = `ghcr.io/wecode-ai/wegent-ci-downloads:v1-${"a".repeat(64)}`;
    const pinned = `ghcr.io/ficohu/wegent-ci-downloads@sha256:${"b".repeat(64)}`;
    assert.equal(resolveCiImage(requested, directory), requested);
    mkdirSync(join(directory, ".github/ci"), { recursive: true });
    const entry = {
      image: pinned,
      platform: "linux/amd64",
      source_commit: "c".repeat(40),
      provenance: "https://github.com/FicoHu/Wegent/actions/runs/1/job/2",
    };
    const save = (override) =>
      writeFileSync(
        join(directory, ".github/ci/prebuilt-images.json"),
        JSON.stringify({
          version: 1,
          images: { [requested]: { ...entry, ...override } },
        }),
      );
    save({});
    assert.equal(resolveCiImage(requested, directory), pinned);
    const changed = requested.replace(/a{64}$/, "d".repeat(64));
    assert.equal(resolveCiImage(changed, directory), changed);
    for (const invalid of [
      { image: "ghcr.io/ficohu/wegent-ci-downloads:latest" },
      { image: pinned.replace("wegent-ci-downloads@", "other@") },
      { platform: "darwin/arm64" },
      { source_commit: "wrong" },
      { provenance: "https://github.com/other/Wegent/actions/runs/1/job/2" },
    ]) {
      save(invalid);
      assert.throws(
        () => resolveCiImage(requested, directory),
        /CI image seed/,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
