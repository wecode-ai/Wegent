import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ciLabels,
  classifySource,
  executorProjects,
  integrationChecks,
} from "./ci-feature-policy.mjs";
import {
  filterDesktop,
  desktopIds,
  loadCatalog,
  readClassifier,
} from "./ci-feature-catalog.mjs";

const providerShardOrder = [3, 2, 1, 4, 5, 6, 7, 8];

function matchesPath(path, pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`).test(path);
}

function consumerRule(path, catalog) {
  return catalog.consumerPaths.find(({ pattern }) =>
    matchesPath(path, pattern),
  );
}

export function requiredFeatures(files, catalog) {
  const required = new Set();
  const unknown = [];
  for (const path of files) {
    if (consumerRule(path, catalog)) continue;
    let features;
    if (path.startsWith("frontend/e2e/tests/")) {
      const owner = catalog.specOwners.get(
        path.slice("frontend/e2e/tests/".length),
      );
      features = owner ? [owner.feature] : ["all"];
    } else {
      features = classifySource(path);
    }
    for (const name of features) required.add(`ci:${name}`);
    if (features.includes("all")) unknown.push(path);
  }
  return { required: [...required].sort(), unknown };
}

function buckets(specs, checks) {
  const shardTotal = providerShardOrder.length;
  const entries = providerShardOrder.map((providerShardIndex, index) => ({
    shardIndex: index + 1,
    shardTotal,
    providerShardIndex,
    specs: [],
    provider: [],
    checks: [],
  }));
  const regular = specs.filter((spec) =>
    ["chromium", "api"].includes(spec.project),
  );
  const provider = specs.filter(
    (spec) => spec.project === "provider-native-chromium",
  );
  regular.forEach((spec, index) =>
    entries[index % shardTotal].specs.push(spec.file),
  );
  provider.forEach((spec, index) =>
    entries[providerShardOrder.indexOf((index % shardTotal) + 1)].provider.push(
      spec.file,
    ),
  );
  for (const id of checks) {
    for (const shard of integrationChecks[id].shards)
      entries[shard - 1].checks.push(id);
  }
  for (const entry of entries)
    entry.dingtalkOAuth = entry.checks.includes("dingtalk_documents");
  return entries.filter(
    (entry) =>
      entry.specs.length || entry.provider.length || entry.checks.length,
  );
}

export function buildPlan({
  files,
  labels,
  event = "pull_request",
  head,
  base,
  baseRef = "main",
  draft = false,
  catalog,
  legacyDesktop,
  surfaces = { platform: true, desktop: true },
}) {
  const normalized = ciLabels(labels);
  const { required, unknown } = requiredFeatures(files, catalog);
  const known = new Set([
    ...Object.values(catalog.features).map((feature) => feature.label),
    "ci:all",
    "ci:windows",
    "ci:macos",
    "ci:memory",
  ]);
  const invalid = normalized.filter((label) => !known.has(label));
  const scopedTargets = new Set(
    files.flatMap((path) => consumerRule(path, catalog)?.targets ?? []),
  );
  const automaticFull = files.some(
    (path) =>
      !consumerRule(path, catalog) &&
      catalog.policyPaths.some((pattern) => matchesPath(path, pattern)),
  );
  const full =
    automaticFull ||
    event !== "pull_request" ||
    normalized.includes("ci:all") ||
    normalized.includes("ci:release");
  const fullPlatform = full || scopedTargets.has("platform_e2e");
  const fullDesktop = full || scopedTargets.has("wework_e2e");
  const missing =
    event !== "pull_request"
      ? []
      : required.filter((label) =>
          label === "ci:all"
            ? !automaticFull && !normalized.includes(label)
            : !full && !normalized.includes(label),
        );
  const selected = Object.keys(catalog.features).filter(
    (name) => full || normalized.includes(`ci:${name}`),
  );
  // Required tags preserve existing client ownership. Extra tags explicitly widen it.
  const extra = selected.filter((name) => !required.includes(`ci:${name}`));
  const platformFeatures = fullPlatform
    ? Object.keys(catalog.features)
    : selected.filter((name) => surfaces.platform || extra.includes(name));
  const desktopFeatures = fullDesktop
    ? Object.keys(catalog.features)
    : selected.filter(
        (name) =>
          surfaces.desktop ||
          normalized.includes("ci:windows") ||
          normalized.includes("ci:macos") ||
          extra.includes(name),
      );
  const specs = platformFeatures
    .flatMap((name) => catalog.features[name].specs)
    .sort((a, b) => a.file.localeCompare(b.file));
  const checks = Object.entries(integrationChecks)
    .filter(([, check]) =>
      check.features.some((name) => platformFeatures.includes(name)),
    )
    .map(([id]) => id);
  const desktop = new Set(
    desktopFeatures.flatMap((name) => catalog.features[name].desktop),
  );
  const previous = desktopIds(legacyDesktop, catalog.plugins);
  const allDesktop = desktopIds(catalog.all, catalog.plugins);
  const mandatoryDesktop =
    surfaces.desktop && previous.size < allDesktop.size ? previous : new Set();
  if (!fullDesktop && mandatoryDesktop.size) {
    desktop.clear();
    for (const id of mandatoryDesktop) desktop.add(id);
    for (const name of extra)
      for (const id of catalog.features[name].desktop) desktop.add(id);
  }
  const matrices =
    event === "merge_group"
      ? legacyDesktop
      : fullDesktop
        ? catalog.all
        : filterDesktop(catalog.all, desktop, catalog.plugins);
  const platformMatrix = fullPlatform
    ? providerShardOrder.map((providerShardIndex, index) => ({
        shardIndex: index + 1,
        shardTotal: providerShardOrder.length,
        dingtalkOAuth:
          integrationChecks.dingtalk_documents.shards.includes(index + 1),
        providerShardIndex,
      }))
    : buckets(specs, checks);
  const executor =
    fullPlatform ||
    specs.some((spec) => executorProjects.includes(spec.project));
  const errors = [
    ...invalid.map((label) => `Unknown CI label: ${label}`),
    ...missing.map((label) => `Missing required label: ${label}`),
  ];
  if (
    normalized.includes("ci:windows") &&
    matrices.wework_desktop_core_e2e !== "true"
  )
    errors.push(
      "ci:windows requires a feature with registered Windows Core coverage",
    );
  if (normalized.includes("ci:macos") && !desktop.size)
    errors.push(
      "ci:macos requires a desktop feature; this gate covers the existing Inspector suite",
    );
  const policyHash = createHash("sha256")
    .update(catalog.text)
    .update(readFileSync(new URL("./lib/ci-policy-paths.sh", import.meta.url)))
    .update(readFileSync(new URL("./ci-feature-policy.mjs", import.meta.url)))
    .digest("hex");
  const plan = {
    version: 1,
    event,
    head,
    base,
    baseRef,
    draft,
    labels: normalized,
    required,
    missing,
    unknown,
    selected,
    surfaces,
    desktop: [...desktopIds(matrices, catalog.plugins)].sort(),
    mandatoryDesktop: [...mandatoryDesktop].sort(),
    full,
    fullPlatform,
    automaticFull,
    scopedTargets: [...scopedTargets].sort(),
    specs,
    checks,
    platformMatrix,
    executor,
    errors,
    policyHash,
  };
  plan.hash = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
  const valid = !errors.length;
  const active = event !== "pull_request" || (valid && !draft);
  const outputs = {
    ...matrices,
    ci_feature_plan: JSON.stringify(plan),
    ci_feature_valid: String(valid),
    memory_suite: String(
      active &&
        event === "pull_request" &&
        (automaticFull || normalized.includes("ci:all")),
    ),
    platform_e2e: String(active && (platformMatrix.length > 0 || executor)),
    platform_suite: String(active && platformMatrix.length > 0),
    executor_suite: String(active && executor),
    platform_matrix: JSON.stringify({ include: platformMatrix }),
    wework_e2e: String(active && (fullDesktop || desktop.size > 0)),
    wework_desktop_macos_inspector_e2e: String(
      active &&
        event !== "merge_group" &&
        (full ||
          normalized.includes("ci:macos") ||
          legacyDesktop.wework_desktop_macos_inspector_e2e === "true"),
    ),
    windows_desktop_core_e2e: String(
      active &&
        event !== "merge_group" &&
        matrices.wework_desktop_core_e2e === "true" &&
        (full || normalized.includes("ci:windows")),
    ),
  };
  if (!active)
    Object.assign(
      outputs,
      filterDesktop(catalog.all, new Set(), catalog.plugins),
    );
  return { plan, outputs };
}

export async function readCurrentPullRequest(number, token) {
  if (!token)
    throw new Error("GITHUB_TOKEN is required to verify current PR state");
  const response = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/pulls/${number}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok)
    throw new Error(`Cannot verify current PR state: HTTP ${response.status}`);
  return response.json();
}

export function assertCurrentPlan(plan, current) {
  if (plan.errors.length) throw new Error(plan.errors.join("\n"));
  if (
    current.head.sha !== plan.head ||
    current.base.ref !== plan.baseRef ||
    Boolean(current.draft) !== Boolean(plan.draft) ||
    JSON.stringify(ciLabels(current.labels)) !== JSON.stringify(plan.labels)
  ) {
    throw new Error(
      "PR head, target branch or CI labels changed; the current CI plan must finish before merging",
    );
  }
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const eventName = process.env.GITHUB_EVENT_NAME;
  const pr = event.pull_request;
  let current = pr;
  if (pr) {
    current = await readCurrentPullRequest(
      event.number,
      process.env.GITHUB_TOKEN,
    );
    if (
      current.head.sha !== pr.head.sha ||
      current.base.ref !== pr.base.ref ||
      current.draft !== pr.draft
    )
      throw new Error("Stale PR event; waiting for the latest run");
  }
  const head =
    pr?.head.sha ?? event.merge_group?.head_sha ?? process.env.GITHUB_SHA;
  const base = pr?.base.sha ?? event.merge_group?.base_sha ?? event.before;
  const fullEvent = ["schedule", "workflow_dispatch"].includes(eventName);
  const files = fullEvent
    ? []
    : execFileSync(
        "git",
        ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`],
        { cwd: root, encoding: "utf8" },
      )
        .split("\0")
        .filter(Boolean);
  if (files.some((path) => /[\r\n]/.test(path)))
    throw new Error(
      "Changed paths containing newlines cannot be classified safely",
    );
  const catalog = await loadCatalog(root);
  const desktopFiles =
    eventName === "merge_group"
      ? files.filter((path) => !path.startsWith(".github/"))
      : files;
  const legacyDesktop = readClassifier(
    root,
    "classify-wework-desktop-e2e.sh",
    desktopFiles,
    fullEvent,
  );
  // Keep the module classifier as the source of truth for affected clients.
  const baseline = readClassifier(
    root,
    "classify-ci-changes.sh",
    files,
    fullEvent || ciLabels(current?.labels ?? []).includes("ci:all"),
  );
  const { plan, outputs } = buildPlan({
    files,
    labels: current?.labels ?? [],
    event: eventName,
    head,
    base,
    baseRef: pr?.base.ref,
    draft: current?.draft ?? false,
    catalog,
    legacyDesktop,
    surfaces: {
      platform: baseline.platform_e2e === "true",
      desktop:
        baseline.wework_e2e === "true" ||
        legacyDesktop.wework_desktop_e2e === "true",
    },
  });
  if (eventName === "merge_group") outputs.wework_e2e = baseline.wework_e2e;
  for (const [name, value] of Object.entries({ ...baseline, ...outputs }))
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  const report = `### CI feature plan\n\nCommit: \`${head}\` · Plan: \`${plan.hash}\`\n\nRequired: ${plan.required.join(", ") || "none"}\n\nSelected: ${plan.selected.join(", ") || "none"}\n\n${plan.errors.length ? plan.errors.map((error) => `- ${error}`).join("\n") : "Coverage labels are complete."}\n\n${plan.unknown.length ? `Paths requiring full coverage:\n${plan.unknown.map((path) => `- \`${path}\``).join("\n")}` : ""}\n`;
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  console.log(report);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
