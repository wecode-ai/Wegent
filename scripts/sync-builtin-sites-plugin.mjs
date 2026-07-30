#!/usr/bin/env node

import { access, cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = resolve(scriptDirectory, "..");
const defaultSourceRoot = resolve(
  workspaceDirectory,
  "..",
  "wegent-skills",
  "wb-plugins",
  "sites",
);
const configuredSourceRoot =
  process.env.WEGENT_SITES_PLUGIN_SOURCE?.trim() || process.argv[2]?.trim();
const sourceRoot = resolve(configuredSourceRoot || defaultSourceRoot);
const destinationDirectory = join(
  workspaceDirectory,
  "backend",
  "init_data",
  "plugins",
  "wegent-sites",
);

async function resolvePluginDirectory(rootDirectory) {
  const candidates = [rootDirectory, join(rootDirectory, "plugin")];
  for (const candidate of candidates) {
    try {
      await access(join(candidate, ".codex-plugin", "plugin.json"));
      return candidate;
    } catch {
      // Try the next supported source layout.
    }
  }
  throw new Error(
    `Sites plugin not found under "${rootDirectory}". Set WEGENT_SITES_PLUGIN_SOURCE to the external sites project or plugin directory.`,
  );
}

let sourceDirectory;
try {
  sourceDirectory = await resolvePluginDirectory(sourceRoot);
} catch (error) {
  if (configuredSourceRoot) {
    throw error;
  }
  console.log(
    `Optional Sites plugin was not found under "${sourceRoot}"; skipping staging.`,
  );
  process.exit(0);
}
const manifestPath = join(sourceDirectory, ".codex-plugin", "plugin.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.name !== "wegent-sites") {
  throw new Error(
    `Expected plugin "wegent-sites", received "${manifest.name ?? ""}"`,
  );
}

await rm(destinationDirectory, { recursive: true, force: true });
await mkdir(dirname(destinationDirectory), { recursive: true });
await cp(sourceDirectory, destinationDirectory, {
  recursive: true,
  force: true,
  preserveTimestamps: true,
});

console.log(
  `Synced wegent-sites ${manifest.version ?? "unknown"} from ${sourceDirectory} into Backend init data`,
);
