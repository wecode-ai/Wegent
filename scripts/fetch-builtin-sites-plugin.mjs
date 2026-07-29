#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_ARCHIVE_SIZE_BYTES = 64 * 1024 * 1024;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const syncScript = join(scriptDirectory, "sync-builtin-sites-plugin.mjs");
const archiveUrl = process.env.WEGENT_SITES_PLUGIN_ARCHIVE_URL?.trim();
const expectedChecksum =
  process.env.WEGENT_SITES_PLUGIN_ARCHIVE_SHA256?.trim().toLowerCase();
const authorization =
  process.env.WEGENT_SITES_PLUGIN_ARCHIVE_AUTHORIZATION?.trim();

if (!archiveUrl) {
  console.log(
    "WEGENT_SITES_PLUGIN_ARCHIVE_URL is not configured; skipping optional Sites plugin staging.",
  );
  process.exit(0);
}
if (!expectedChecksum || !/^[a-f0-9]{64}$/.test(expectedChecksum)) {
  throw new Error(
    "WEGENT_SITES_PLUGIN_ARCHIVE_SHA256 must be the pinned 64-character SHA-256 checksum.",
  );
}

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

async function downloadArchive() {
  const response = await fetch(archiveUrl, {
    headers: authorization ? { Authorization: authorization } : undefined,
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(
      `Failed to download the Sites plugin archive: HTTP ${response.status}`,
    );
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_ARCHIVE_SIZE_BYTES) {
    throw new Error(
      `Sites plugin archive exceeds ${MAX_ARCHIVE_SIZE_BYTES} bytes.`,
    );
  }

  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length > MAX_ARCHIVE_SIZE_BYTES) {
    throw new Error(
      `Sites plugin archive exceeds ${MAX_ARCHIVE_SIZE_BYTES} bytes.`,
    );
  }
  const actualChecksum = createHash("sha256").update(archive).digest("hex");
  if (actualChecksum !== expectedChecksum) {
    throw new Error(
      `Sites plugin archive checksum mismatch: expected ${expectedChecksum}, received ${actualChecksum}.`,
    );
  }
  return archive;
}

async function findSitesPlugin(directory, depth = 0) {
  if (depth > 8) return null;
  try {
    const manifestPath = join(directory, ".codex-plugin", "plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.name === "wegent-sites") return directory;
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
    const result = await findSitesPlugin(
      join(directory, entry.name),
      depth + 1,
    );
    if (result) return result;
  }
  return null;
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "wegent-sites-"));
try {
  const archivePath = join(
    temporaryDirectory,
    basename(new URL(archiveUrl).pathname) || "wegent-sites.zip",
  );
  const extractedDirectory = join(temporaryDirectory, "extracted");
  const archive = await downloadArchive();
  await writeFile(archivePath, archive);
  await run("unzip", ["-q", archivePath, "-d", extractedDirectory]);

  const pluginDirectory = await findSitesPlugin(extractedDirectory);
  if (!pluginDirectory) {
    throw new Error(
      "The downloaded archive does not contain a wegent-sites Codex plugin.",
    );
  }
  await run(process.execPath, [syncScript, resolve(pluginDirectory)]);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
