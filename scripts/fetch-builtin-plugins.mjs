#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  builtinPluginStagingDefinitions,
  stageBuiltinPlugin,
} from "./builtin-plugin-staging.mjs";

const MAX_ARCHIVE_SIZE_BYTES = 64 * 1024 * 1024;

async function run(command, args) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(
          `${command} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`,
        ),
      );
    });
  });
}

async function downloadArchive(
  definition,
  archiveUrl,
  expectedChecksum,
  authorization,
) {
  const response = await fetch(archiveUrl, {
    headers: authorization ? { Authorization: authorization } : undefined,
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(
      `Failed to download the ${definition.label} plugin archive: HTTP ${response.status}`,
    );
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_ARCHIVE_SIZE_BYTES) {
    throw new Error(
      `${definition.label} plugin archive exceeds ${MAX_ARCHIVE_SIZE_BYTES} bytes.`,
    );
  }

  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length > MAX_ARCHIVE_SIZE_BYTES) {
    throw new Error(
      `${definition.label} plugin archive exceeds ${MAX_ARCHIVE_SIZE_BYTES} bytes.`,
    );
  }
  const actualChecksum = createHash("sha256").update(archive).digest("hex");
  if (actualChecksum !== expectedChecksum) {
    throw new Error(
      `${definition.label} plugin archive checksum mismatch: expected ${expectedChecksum}, received ${actualChecksum}.`,
    );
  }
  return archive;
}

async function findPlugin(directory, pluginName, depth = 0) {
  if (depth > 8) return null;
  try {
    const manifestPath = join(directory, ".codex-plugin", "plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.name === pluginName) return directory;
  } catch {
    // Continue searching the extracted archive.
  }

  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.name === ".git" ||
      entry.name === "node_modules"
    ) {
      continue;
    }
    const result = await findPlugin(
      join(directory, entry.name),
      pluginName,
      depth + 1,
    );
    if (result) return result;
  }
  return null;
}

async function fetchAndStagePlugin(definition) {
  const environmentPrefix = definition.archiveEnvironmentPrefix;
  const archiveUrl = process.env[`${environmentPrefix}_URL`]?.trim();
  const expectedChecksum = process.env[`${environmentPrefix}_SHA256`]
    ?.trim()
    .toLowerCase();
  const authorization =
    process.env[`${environmentPrefix}_AUTHORIZATION`]?.trim();

  if (!archiveUrl) {
    console.log(
      `${environmentPrefix}_URL is not configured; skipping optional ${definition.label} plugin staging.`,
    );
    return;
  }
  if (!expectedChecksum || !/^[a-f0-9]{64}$/.test(expectedChecksum)) {
    throw new Error(
      `${environmentPrefix}_SHA256 must be the pinned 64-character SHA-256 checksum.`,
    );
  }

  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), `${definition.name}-`),
  );
  try {
    const archivePath = join(
      temporaryDirectory,
      basename(new URL(archiveUrl).pathname) || `${definition.name}.zip`,
    );
    const extractedDirectory = join(temporaryDirectory, "extracted");
    const archive = await downloadArchive(
      definition,
      archiveUrl,
      expectedChecksum,
      authorization,
    );
    await writeFile(archivePath, archive);
    await run("unzip", ["-q", archivePath, "-d", extractedDirectory]);

    const pluginDirectory = await findPlugin(
      extractedDirectory,
      definition.name,
    );
    if (!pluginDirectory) {
      throw new Error(
        `The downloaded archive does not contain a ${definition.name} Codex plugin.`,
      );
    }
    await stageBuiltinPlugin(definition, {
      sourceRoot: pluginDirectory,
      required: true,
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

for (const definition of builtinPluginStagingDefinitions) {
  await fetchAndStagePlugin(definition);
}
