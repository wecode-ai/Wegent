import { access, cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = resolve(scriptDirectory, "..");

export const builtinPluginStagingDefinitions = [
  {
    name: "wegent-sites",
    label: "Sites",
    sourceEnvironmentVariable: "WEGENT_SITES_PLUGIN_SOURCE",
    archiveEnvironmentPrefix: "WEGENT_SITES_PLUGIN_ARCHIVE",
    defaultSourceRoot: resolve(
      workspaceDirectory,
      "..",
      "wegent-skills",
      "wb-plugins",
      "sites",
    ),
  },
  {
    name: "wegent-mini-program",
    label: "Mini Program",
    sourceEnvironmentVariable: "WEGENT_MINI_PROGRAM_PLUGIN_SOURCE",
    archiveEnvironmentPrefix: "WEGENT_MINI_PROGRAM_PLUGIN_ARCHIVE",
    defaultSourceRoot: resolve(
      workspaceDirectory,
      "..",
      "wegent-skills",
      "wb-plugins",
      "mini-program",
    ),
  },
];

async function resolvePluginDirectory(rootDirectory, definition) {
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
    `${definition.label} plugin not found under "${rootDirectory}". Set ${definition.sourceEnvironmentVariable} to the external project or plugin directory.`,
  );
}

export async function stageBuiltinPlugin(
  definition,
  { sourceRoot, required = false } = {},
) {
  const configuredSourceRoot =
    sourceRoot || process.env[definition.sourceEnvironmentVariable]?.trim();
  const resolvedSourceRoot = resolve(
    configuredSourceRoot || definition.defaultSourceRoot,
  );
  let sourceDirectory;
  try {
    sourceDirectory = await resolvePluginDirectory(
      resolvedSourceRoot,
      definition,
    );
  } catch (error) {
    if (configuredSourceRoot || required) {
      throw error;
    }
    console.log(
      `Optional ${definition.label} plugin was not found under "${resolvedSourceRoot}"; skipping staging.`,
    );
    return false;
  }

  const manifestPath = join(sourceDirectory, ".codex-plugin", "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.name !== definition.name) {
    throw new Error(
      `Expected plugin "${definition.name}", received "${manifest.name ?? ""}"`,
    );
  }

  const destinationDirectory = join(
    workspaceDirectory,
    "backend",
    "init_data",
    "plugins",
    definition.name,
  );
  await rm(destinationDirectory, { recursive: true, force: true });
  await mkdir(dirname(destinationDirectory), { recursive: true });
  await cp(sourceDirectory, destinationDirectory, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
  });

  console.log(
    `Synced ${definition.name} ${manifest.version ?? "unknown"} from ${sourceDirectory} into Backend init data`,
  );
  return true;
}
