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

function assertOrganizationSeeds({ version, images }) {
  assert.equal(version, 1);
  assert.equal(typeof images, "object");
  assert.ok(images !== null && !Array.isArray(images));
  for (const [reference, entry] of Object.entries(images)) {
    assert.match(reference, /^ghcr\.io\/wecode-ai\//);
    assert.match(
      entry.image,
      /^ghcr\.io\/wecode-ai\/[^@]+@sha256:[a-f0-9]{64}$/,
    );
    assert.match(
      entry.provenance,
      /^https:\/\/github\.com\/wecode-ai\/Wegent\/actions\/runs\/\d+\/job\/\d+$/,
    );
  }
}

test("checked-in image seeds use organization-owned images and build provenance", () => {
  const file = new URL("../ci/prebuilt-images.json", import.meta.url);
  const index = JSON.parse(readFileSync(file, "utf8"));
  assertOrganizationSeeds(index);
  const { images } = index;
  for (const [reference, entry] of Object.entries(images)) {
    assert.equal(
      resolveCiImage(reference, undefined, entry.platform),
      entry.image,
    );
  }
});

test("organization index rejects personal images and provenance", () => {
  const reference = `ghcr.io/wecode-ai/wegent-ci-downloads:v1-${"a".repeat(64)}`;
  const entry = {
    image: `ghcr.io/wecode-ai/wegent-ci-downloads@sha256:${"b".repeat(64)}`,
    provenance: "https://github.com/wecode-ai/Wegent/actions/runs/1/job/2",
  };
  const index = { version: 1, images: { [reference]: entry } };
  assertOrganizationSeeds(index);
  for (const override of [
    { image: entry.image.replace("/wecode-ai/", "/personal-owner/") },
    { provenance: entry.provenance.replace("/wecode-ai/", "/personal-owner/") },
  ]) {
    assert.throws(() =>
      assertOrganizationSeeds({
        ...index,
        images: { [reference]: { ...entry, ...override } },
      }),
    );
  }
});

test("an empty index preserves organization source references on both platforms", () => {
  const directory = mkdtempSync(join(tmpdir(), "wegent-ci-seeds-empty-"));
  try {
    mkdirSync(join(directory, ".github/ci"), { recursive: true });
    const index = { version: 1, images: {} };
    assertOrganizationSeeds(index);
    writeFileSync(
      join(directory, ".github/ci/prebuilt-images.json"),
      JSON.stringify(index),
    );
    for (const platform of ["linux/amd64", "darwin/arm64"]) {
      const reference = `ghcr.io/wecode-ai/wegent-ci-downloads:v1-${"a".repeat(64)}`;
      assert.equal(resolveCiImage(reference, directory, platform), reference);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("immutable public seeds only match identical build input keys", () => {
  const directory = mkdtempSync(join(tmpdir(), "wegent-ci-seeds-"));
  try {
    const requested = `ghcr.io/wecode-ai/wegent-ci-downloads:v1-${"a".repeat(64)}`;
    const pinned = `ghcr.io/wecode-ai/wegent-ci-downloads@sha256:${"b".repeat(64)}`;
    assert.equal(resolveCiImage(requested, directory), requested);
    mkdirSync(join(directory, ".github/ci"), { recursive: true });
    const entry = {
      image: pinned,
      platform: "linux/amd64",
      source_commit: "c".repeat(40),
      provenance: "https://github.com/wecode-ai/Wegent/actions/runs/1/job/2",
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
    save({ platform: "darwin/arm64" });
    assert.throws(() => resolveCiImage(requested, directory), /CI image seed/);
    assert.equal(resolveCiImage(requested, directory, "darwin/arm64"), pinned);
    save({});
    const changed = requested.replace(/a{64}$/, "d".repeat(64));
    assert.equal(resolveCiImage(changed, directory), changed);
    for (const invalid of [
      { image: "ghcr.io/wecode-ai/wegent-ci-downloads:latest" },
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
