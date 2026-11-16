import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function inspect(root, name) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(name) || basename(name) !== name) {
    throw new Error(`Invalid runtime artifact filename: ${name}`);
  }
  const path = join(root, name);
  if (!lstatSync(path).isFile())
    throw new Error(`Expected regular file: ${name}`);
  const bytes = readFileSync(path);
  if (!bytes.length) throw new Error(`Empty runtime artifact: ${name}`);
  return { name, size: bytes.length, sha256: digest(bytes) };
}

export function runtimeArtifact(
  mode,
  root,
  component,
  sourceRef,
  files,
  headSha,
  target = "linux-x64",
  profile = "release",
) {
  if (!["executor", "backend-rs"].includes(component))
    throw new Error("Unknown runtime");
  if (!headSha || !sourceRef || !files.length)
    throw new Error("Missing runtime identity");
  if (!["linux-x64", "darwin-arm64"].includes(target))
    throw new Error("Unsupported runtime target");
  if (!["release", "dev"].includes(profile))
    throw new Error("Unsupported runtime profile");
  const path = join(root, `${component}-runtime-manifest.json`);
  const identity = {
    schema: 1,
    component,
    headSha,
    sourceRef,
    target,
    profile,
  };
  if (mode === "create") {
    writeFileSync(
      path,
      `${JSON.stringify({ ...identity, files: files.map((name) => inspect(root, name)) }, null, 2)}\n`,
    );
    return;
  }
  if (mode !== "verify") throw new Error("Expected create or verify");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  for (const [key, value] of Object.entries(identity)) {
    if (manifest[key] !== value) throw new Error(`Runtime ${key} mismatch`);
  }
  if (
    !Array.isArray(manifest.files) ||
    new Set(manifest.files.map((file) => file.name)).size !==
      manifest.files.length
  ) {
    throw new Error("Invalid runtime file inventory");
  }
  for (const name of files) {
    if (!manifest.files.some((file) => file.name === name))
      throw new Error(`Missing runtime file: ${name}`);
  }
  for (const file of manifest.files) {
    const actual = inspect(root, file.name);
    if (file.size !== actual.size || file.sha256 !== actual.sha256) {
      throw new Error(`Runtime checksum mismatch: ${file.name}`);
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  const [mode, root, component, sourceRef, ...files] = process.argv.slice(2);
  runtimeArtifact(
    mode,
    root,
    component,
    sourceRef,
    files,
    process.env.RUNTIME_HEAD_SHA,
    process.env.RUNTIME_TARGET,
    process.env.RUNTIME_PROFILE,
  );
}
