import { execFileSync } from "node:child_process";
import {
  readFileSync,
  readdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { executorProjects, integrationChecks } from "./ci-feature-policy.mjs";

export function readClassifier(root, script, files, all = false) {
  const directory = mkdtempSync(resolve(tmpdir(), "wegent-ci-classifier-"));
  const outputFile = resolve(directory, "outputs");
  writeFileSync(outputFile, "");
  let output;
  try {
    // Node captures stdout through a socket on Linux; Bash cannot reopen it.
    execFileSync(
      "bash",
      [resolve(root, ".github/scripts", script), ...(all ? ["--all"] : [])],
      {
        cwd: root,
        input: files.length ? files.join("\n") + "\n" : "",
        encoding: "utf8",
        env: { ...process.env, GITHUB_OUTPUT: outputFile },
      },
    );
    output = readFileSync(outputFile, "utf8");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return Object.fromEntries(
    output
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator < 1)
          throw new Error(`Invalid classifier output: ${line}`);
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

export const desktopKeys = {
  core: "wework_desktop_core_e2e_matrix",
  cloud: "wework_desktop_cloud_e2e_matrix",
  plugins: "wework_desktop_other_e2e_matrix",
};

export function desktopIds(matrix, plugins) {
  const result = new Set();
  for (const [kind, key] of Object.entries(desktopKeys)) {
    for (const entry of JSON.parse(matrix[key]).include) {
      const segments =
        kind === "plugins"
          ? entry.segment
            ? entry.segment.split(",")
            : plugins
          : entry.segments.split(",");
      for (const name of segments) result.add(`${kind}:${name}`);
    }
  }
  return result;
}

export function filterDesktop(matrix, selected, plugins) {
  const result = {};
  for (const [kind, key] of Object.entries(desktopKeys)) {
    const entries = JSON.parse(matrix[key]).include.flatMap((entry) => {
      const names = kind === "plugins" ? plugins : entry.segments.split(",");
      const segments = names.filter((name) => selected.has(`${kind}:${name}`));
      if (!segments.length) return [];
      return [
        {
          ...entry,
          [kind === "plugins" ? "segment" : "segments"]: segments.join(","),
        },
      ];
    });
    result[key] = JSON.stringify({ include: entries });
    const flag = kind === "plugins" ? "other" : kind;
    result[`wework_desktop_${flag}_e2e`] = String(entries.length > 0);
  }
  result.wework_desktop_e2e = String(
    Object.keys(desktopKeys).some(
      (kind) =>
        result[`wework_desktop_${kind === "plugins" ? "other" : kind}_e2e`] ===
        "true",
    ),
  );
  return result;
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(resolve(directory, entry.name))
      : [resolve(directory, entry.name)],
  );
}

export async function loadCatalog(root) {
  const text = readFileSync(resolve(root, ".github/ci/features.json"), "utf8");
  const catalog = JSON.parse(text);
  const policyPaths = execFileSync(
    "bash",
    [resolve(root, ".github/scripts/lib/ci-policy-paths.sh"), "--list"],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n");
  const consumerPaths = execFileSync(
    "bash",
    [
      resolve(root, ".github/scripts/lib/ci-policy-paths.sh"),
      "--list-consumers",
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .map((entry) => {
      const [pattern, targets] = entry.split("|");
      return { pattern, targets: targets.split(" ").filter(Boolean) };
    });
  if (catalog.version !== 1)
    throw new Error(`Unsupported feature catalog version: ${catalog.version}`);
  const registry = await import(
    pathToFileURL(resolve(root, "wework/e2e/desktop/checkpoints.mjs"))
  );
  const all = readClassifier(root, "classify-wework-desktop-e2e.sh", [], true);
  const core = new Set(
    JSON.parse(all[desktopKeys.core]).include.flatMap((entry) =>
      entry.segments.split(","),
    ),
  );
  const plugins = registry.PLUGIN_SEGMENTS.filter((name) => !core.has(name));
  const expected = desktopIds(all, plugins);
  const claimed = new Set();
  const specOwners = new Map();
  const projects = new Set([
    "chromium",
    "api",
    "provider-native-chromium",
    ...executorProjects,
  ]);
  for (const [name, feature] of Object.entries(catalog.features)) {
    if (feature.label !== `ci:${name}`)
      throw new Error(`Invalid label for ${name}`);
    for (const id of feature.desktop) {
      if (!expected.has(id)) throw new Error(`Unknown desktop CI entry: ${id}`);
      claimed.add(id);
    }
    for (const spec of feature.specs) {
      if (!projects.has(spec.project) || spec.file.includes(".."))
        throw new Error(`Invalid spec: ${spec.file}`);
      if (specOwners.has(spec.file))
        throw new Error(`Duplicate spec owner: ${spec.file}`);
      specOwners.set(spec.file, { ...spec, feature: name });
    }
  }
  for (const id of expected)
    if (!claimed.has(id))
      throw new Error(`Desktop CI entry has no feature: ${id}`);
  const testRoot = resolve(root, "frontend/e2e/tests");
  const actual = walk(testRoot)
    .filter(
      (path) => path.endsWith(".spec.ts") && !path.includes("/__snapshots__/"),
    )
    .map((path) => path.slice(testRoot.length + 1));
  for (const file of actual)
    if (!specOwners.has(file)) throw new Error(`Spec has no feature: ${file}`);
  for (const file of specOwners.keys())
    if (!actual.includes(file)) throw new Error(`Missing spec: ${file}`);
  for (const check of Object.values(integrationChecks)) {
    for (const name of check.features)
      if (!catalog.features[name])
        throw new Error(`Unknown integration feature: ${name}`);
  }
  return {
    ...catalog,
    text,
    all,
    plugins,
    specOwners,
    policyPaths,
    consumerPaths,
  };
}
