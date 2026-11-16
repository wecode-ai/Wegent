import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { packageConnectionRuntime } from "../../wework/scripts/package-connection-runtime.mjs";

const [baseImage, rawArtifact, image, ...extra] = process.argv.slice(2);
assert.ok(
  process.platform === "linux" &&
    baseImage &&
    rawArtifact &&
    image &&
    !extra.length,
  "Use the existing Linux desktop build, its CI tools image and one fixture image tag",
);
const artifact = resolve(rawArtifact);
const directory = await mkdtemp(join(tmpdir(), "event-remote-image-"));
const execute = promisify(execFile);
const run = (command, args) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolveRun()
        : reject(new Error(`${command} exited ${code}`)),
    );
  });
const localBase = `wework-event-fixture-base:${process.pid}`;
let baseTagged = false;
try {
  const catalogRoot = join(artifact, "electron-app/resources/harness-runtime");
  const catalog = JSON.parse(
    await readFile(join(catalogRoot, "runtimes.json"), "utf8"),
  );
  const runtime = catalog.runtimes.find((item) => item.role === "core");
  assert.ok(runtime && basename(runtime.assetName) === runtime.assetName);
  const archive = join(catalogRoot, runtime.assetName);
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(archive)) hash.update(bytes);
  assert.equal(
    hash.digest("hex"),
    runtime.archiveSha256,
    "Use the exact shared DSH runtime archive",
  );
  const unpacked = join(directory, "runtime-input");
  await mkdir(unpacked);
  await run("tar", ["-xzf", archive, "-C", unpacked]);
  await packageConnectionRuntime({
    runtimeRoot: unpacked,
    dshRoot: resolve("wework/dsh"),
    nodeExecutable: process.execPath,
    destination: join(directory, "connection-runtime"),
  });
  await rm(unpacked, { recursive: true });
  await cp(
    join(artifact, "electron-app/resources/bin/wegent-executor"),
    join(directory, "executor"),
  );
  await cp(
    join(
      artifact,
      "codex/x86_64-unknown-linux-gnu/vendor/x86_64-unknown-linux-musl/bin/codex",
    ),
    join(directory, "codex"),
  );
  await execute("docker", ["tag", baseImage, localBase]);
  baseTagged = true;
  await run("docker", [
    "build",
    "--file",
    resolve("wework/e2e/desktop/fixtures/event-remote-device/Dockerfile"),
    "--build-arg",
    `BASE_IMAGE=${localBase}`,
    "--tag",
    image,
    directory,
  ]);
  await run("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "/app/executor",
    image,
    "--version",
  ]);
  await run("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "/usr/local/bin/codex",
    image,
    "--version",
  ]);
} finally {
  await rm(directory, { recursive: true, force: true });
  if (baseTagged) await execute("docker", ["image", "rm", localBase]);
}
