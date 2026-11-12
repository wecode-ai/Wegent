#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCiImage } from "./resolve-ci-image.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const definitions = {
  "executor-deps": {
    dockerfile: "frontend/e2e/fixtures/claudecode-executor/Dockerfile",
    target: "builder-deps",
    inputs: [
      "executor/Cargo.toml",
      "executor/Cargo.lock",
      "executor/crates",
      "shared/rust",
      "shared/assets",
      "sdk/plugin-creator",
      "sdk/plugin-auth",
      "executor/vendor",
      ".github/ci/rust-toolchain",
    ],
  },
  "backend-rs-deps": {
    dockerfile: ".github/runtime-images/backend-rs-builder.Dockerfile",
    target: "dependencies",
    inputs: [
      "backend-rs/Cargo.toml",
      "backend-rs/Cargo.lock",
      "backend-rs/crates",
      "shared/rust",
      ".github/ci/rust-toolchain",
    ],
  },
  downloads: {
    dockerfile: ".github/runtime-images/ci-downloads.Dockerfile",
    target: "",
    inputs: [
      "wework/electron/package.json",
      "wework/electron/pnpm-lock.yaml",
      "wework/codex-binaries.lock.json",
      "LICENSES/Apache-2.0.txt",
      "wework/third_party/codex",
      "wework/scripts/prepare-codex-binary.mjs",
      "wework/scripts/lib/process-lock.mjs",
      "wework/scripts/lib/electron-zip-cache.mjs",
    ],
  },
};

function files(directory, input) {
  const path = resolve(directory, input);
  try {
    return readdirSync(path, { withFileTypes: true })
      .flatMap((entry) =>
        entry.isDirectory()
          ? files(directory, `${input}/${entry.name}`)
          : [`${input}/${entry.name}`],
      )
      .sort();
  } catch (error) {
    if (error.code !== "ENOTDIR") throw error;
    return [input];
  }
}

export function prebuiltImage(kind, owner, baseImage = "", directory = root) {
  const definition = definitions[kind];
  if (!definition) throw new Error(`Unsupported prebuilt image: ${kind}`);
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(owner))
    throw new Error("Invalid registry owner");
  if (kind === "executor-deps" && !/@sha256:[a-f0-9]{64}$/.test(baseImage)) {
    throw new Error("Executor dependencies require an immutable base image");
  }
  const hash = createHash("sha256").update("linux-amd64-v1\n");
  if (kind === "executor-deps") hash.update(baseImage);
  const inputs = [definition.dockerfile, ...definition.inputs].flatMap(
    (input) => files(directory, input),
  );
  for (const input of [...new Set(inputs)].sort()) {
    hash
      .update(input)
      .update("\0")
      .update(readFileSync(resolve(directory, input)))
      .update("\0");
  }
  const image = `ghcr.io/${owner.toLowerCase()}/wegent-ci-${kind}:v1-${hash.digest("hex")}`;
  return {
    kind,
    ...definition,
    image,
    restoreImage: resolveCiImage(image, directory),
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [kind, owner = process.env.GITHUB_REPOSITORY_OWNER, baseImage = ""] =
    process.argv.slice(2);
  console.log(JSON.stringify(prebuiltImage(kind, owner, baseImage)));
}
