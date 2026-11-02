#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

export function resolveCiImage(
  reference,
  directory = root,
  platform = "linux/amd64",
) {
  let seeds;
  try {
    seeds = JSON.parse(
      readFileSync(
        resolve(directory, ".github/ci/prebuilt-images.json"),
        "utf8",
      ),
    );
  } catch (error) {
    if (error.code === "ENOENT") return reference;
    throw error;
  }
  if (
    seeds.version !== 1 ||
    typeof seeds.images !== "object" ||
    seeds.images === null
  ) {
    throw new Error("Invalid CI image seed index");
  }
  const entry = seeds.images[reference];
  if (!entry) return reference;
  const source =
    /^ghcr\.io\/[a-z0-9-]+\/([a-z0-9._-]+):(?:[a-z0-9._-]*-)?[a-f0-9]{64}$/.exec(
      reference,
    );
  const target =
    /^ghcr\.io\/([a-z0-9-]+)\/([a-z0-9._-]+)@sha256:[a-f0-9]{64}$/.exec(
      entry.image ?? "",
    );
  if (
    !source ||
    !target ||
    source[1] !== target[2] ||
    !["linux/amd64", "darwin/arm64"].includes(platform) ||
    entry.platform !== platform ||
    !/^[a-f0-9]{40}$/.test(entry.source_commit ?? "") ||
    !/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/actions\/runs\/\d+\/job\/\d+$/.test(
      entry.provenance ?? "",
    )
  ) {
    throw new Error(`Invalid immutable CI image seed: ${reference}`);
  }
  const provenanceOwner = new URL(entry.provenance).pathname
    .split("/")[1]
    .toLowerCase();
  if (provenanceOwner !== target[1])
    throw new Error("CI image seed provenance owner differs");
  return entry.image;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(resolveCiImage(process.argv[2], root, process.argv[3]));
}
