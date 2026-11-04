import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveCiImage } from "./resolve-ci-image.mjs";

export const archiveName = "frontend-next-build.tar.zst";
export const manifestName = "frontend-build-manifest.json";
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const recipeFiles = [
  ".github/actions/build-frontend-e2e/action.yml",
  ".github/actions/setup-node-workspace/action.yml",
  ".github/scripts/frontend-e2e-build.mjs",
  ".github/scripts/archive-frontend-e2e-build.sh",
  ".github/scripts/restore-frontend-e2e-build.sh",
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fontFiles(root, relative = "frontend/public/fonts") {
  try {
    return readdirSync(join(root, relative), { withFileTypes: true }).flatMap(
      (entry) =>
        entry.isDirectory()
          ? fontFiles(root, `${relative}/${entry.name}`)
          : [`${relative}/${entry.name}`],
    );
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export function frontendBuildEnvironment(env) {
  const environment = Object.fromEntries(
    Object.keys(env)
      .filter(
        (name) =>
          name.startsWith("NEXT_PUBLIC_") ||
          ["TURBOPACK", "NODE_OPTIONS"].includes(name),
      )
      .sort()
      .map((name) => [name, env[name]]),
  );
  return {
    ...environment,
    NODE_ENV: env.NODE_ENV || "production",
    NEXT_TELEMETRY_DISABLED: "1",
    I18N_LNG: env.I18N_LNG || "en",
  };
}

export function buildContext(root = repositoryRoot, env = process.env) {
  return {
    profile: "e2e-standalone-v1",
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    nodeAbi: process.versions.modules,
    glibc: process.report.getReport().header.glibcVersionRuntime ?? null,
    pnpm: execFileSync("pnpm", ["--version"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    next: JSON.parse(
      readFileSync(
        join(root, "frontend/node_modules/next/package.json"),
        "utf8",
      ),
    ).version,
    environment: frontendBuildEnvironment(env),
  };
}

export function frontendBuild(root, owner, context) {
  assert.match(owner, /^[a-z0-9][a-z0-9-]*$/i);
  const tracked = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--",
      "frontend",
      "packages",
      "shared/assets",
      "shared/data",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      ".npmrc",
      "patches",
    ],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .filter(
      (path) =>
        !/(^|\/)(e2e|__tests__|node_modules|\.next|test-results)\//.test(
          path,
        ) &&
        !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path) &&
        !/(^|\/)(README[^/]*|AGENTS\.md)$/.test(path),
    );
  const environmentFiles = [
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local",
  ]
    .map((name) => `frontend/${name}`)
    .filter((name) => existsSync(join(root, name)));
  const inputs = [
    ...new Set([
      ...tracked,
      ...fontFiles(root),
      ...environmentFiles,
      ...recipeFiles,
    ]),
  ]
    .sort()
    .map((name) => {
      const path = join(root, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        const actual = realpathSync(path);
        assert(
          actual.startsWith(`${realpathSync(root)}/`),
          "Build input symlink escapes the checkout",
        );
        const targetStat = lstatSync(actual);
        assert(
          targetStat.isFile(),
          "Directory build input symlinks require an explicit input inventory",
        );
        return {
          name,
          mode: targetStat.mode & 0o777,
          symlink: target,
          sha256: sha256(readFileSync(actual)),
        };
      }
      assert(stat.isFile(), `Expected regular build input: ${name}`);
      return {
        name,
        mode: stat.mode & 0o777,
        sha256: sha256(readFileSync(path)),
      };
    });
  const sourceKey = sha256(JSON.stringify({ schema: 1, context, inputs }));
  const image = `ghcr.io/${owner.toLowerCase()}/wegent-ci-downloads:frontend-v1-${sourceKey}`;
  return {
    schema: 1,
    sourceKey,
    context,
    image,
    restoreImage: resolveCiImage(image, root),
  };
}

function checkIdentity(identity) {
  assert.match(identity.headSha ?? "", /^[a-f0-9]{40}$/);
  assert.match(String(identity.runId ?? ""), /^\d+$/);
  assert.match(identity.repository ?? "", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
}

export function currentIdentity(env = process.env, root = repositoryRoot) {
  const identity = {
    headSha:
      env.FRONTEND_HEAD_SHA ||
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
    runId: String(env.GITHUB_RUN_ID || ""),
    repository: env.GITHUB_REPOSITORY,
  };
  checkIdentity(identity);
  return identity;
}

function archiveInventory(directory) {
  const path = join(directory, archiveName);
  assert(lstatSync(path).isFile(), "Frontend archive must be a regular file");
  const bytes = readFileSync(path);
  assert(bytes.length > 0, "Frontend archive is empty");
  return [{ name: archiveName, size: bytes.length, sha256: sha256(bytes) }];
}

export function describeBuild(directory, metadata, identity, buildId) {
  checkIdentity(identity);
  assert.match(buildId, /^[A-Za-z0-9_-]{1,100}$/);
  const manifest = {
    schema: 1,
    kind: "frontend-e2e",
    sourceKey: metadata.sourceKey,
    context: metadata.context,
    buildId,
    origin: { ...identity },
    verifiedFor: { ...identity },
    files: archiveInventory(directory),
  };
  writeFileSync(
    join(directory, manifestName),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

export function verifyBuild(directory, metadata, identity) {
  const path = join(directory, manifestName);
  assert(lstatSync(path).isFile(), "Frontend manifest must be a regular file");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(manifest.schema, 1, "Frontend manifest schema mismatch");
  assert.equal(
    manifest.kind,
    "frontend-e2e",
    "Frontend artifact kind mismatch",
  );
  assert.match(manifest.sourceKey ?? "", /^[a-f0-9]{64}$/);
  assert.match(manifest.buildId ?? "", /^[A-Za-z0-9_-]{1,100}$/);
  assert.equal(manifest.context?.profile, "e2e-standalone-v1");
  assert.equal(manifest.context?.platform, "linux-x64");
  checkIdentity(manifest.origin);
  checkIdentity(manifest.verifiedFor);
  if (metadata) {
    assert.equal(
      manifest.sourceKey,
      metadata.sourceKey,
      "Frontend build input mismatch",
    );
    assert.deepEqual(
      manifest.context,
      metadata.context,
      "Frontend build context mismatch",
    );
  }
  if (identity)
    assert.deepEqual(
      manifest.verifiedFor,
      identity,
      "Frontend current producer identity mismatch",
    );
  assert.deepEqual(
    manifest.files,
    archiveInventory(directory),
    "Frontend archive inventory or SHA256 mismatch",
  );
  return manifest;
}

export function attestBuild(directory, metadata, identity, restoredFrom) {
  const manifest = verifyBuild(directory, metadata);
  checkIdentity(identity);
  manifest.verifiedFor = { ...identity };
  if (restoredFrom) manifest.restoredFrom = restoredFrom;
  writeFileSync(
    join(directory, manifestName),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [mode, path = ".ci-artifacts", metadataFile] = process.argv.slice(2);
  if (mode === "key") {
    console.log(
      JSON.stringify(
        frontendBuild(
          repositoryRoot,
          process.env.GITHUB_REPOSITORY_OWNER,
          buildContext(),
        ),
      ),
    );
  } else if (mode === "describe") {
    describeBuild(
      path,
      JSON.parse(readFileSync(metadataFile, "utf8")),
      currentIdentity(),
      readFileSync("frontend/.next/BUILD_ID", "utf8").trim(),
    );
  } else if (mode === "attest") {
    attestBuild(
      path,
      JSON.parse(readFileSync(metadataFile, "utf8")),
      currentIdentity(),
      process.env.FRONTEND_RESTORED_FROM,
    );
  } else if (mode === "verify-current") {
    verifyBuild(path, undefined, currentIdentity());
  } else if (mode === "check-restored") {
    const manifest = JSON.parse(readFileSync(join(path, manifestName), "utf8"));
    assert.equal(
      readFileSync("frontend/.next/BUILD_ID", "utf8").trim(),
      manifest.buildId,
      "Restored frontend BUILD_ID mismatch",
    );
  } else throw new Error(`Unknown frontend artifact operation: ${mode}`);
}
