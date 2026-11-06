import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  executorProjectGroups,
  executorProjects,
} from "./ci-feature-policy.mjs";

export function playwrightInvocation(plan, args) {
  if (plan.errors.length)
    throw new Error("Cannot run an invalid CI feature plan");
  if (plan.fullPlatform) return args;
  const projects = args
    .filter((arg) => arg.startsWith("--project="))
    .map((arg) => arg.slice("--project=".length));
  const shard = args.find((arg) => arg.startsWith("--shard="));
  const index = shard
    ? Number(shard.slice("--shard=".length).split("/")[0])
    : undefined;
  let files;
  let bucket;
  const executorGroup = executorProjectGroups.find((group) =>
    projects.some((project) => group.includes(project)),
  );
  if (executorGroup) {
    if (
      projects.some(
        (project) =>
          executorProjects.includes(project) &&
          !executorGroup.includes(project),
      )
    )
      throw new Error(
        "Executor phases with different Backend configuration require separate invocations",
      );
    const specs = plan.specs.filter((spec) =>
      executorGroup.includes(spec.project),
    );
    files = specs.map((spec) => spec.file);
    const selectedProjects = new Set(specs.map((spec) => spec.project));
    args = [
      ...args.filter((arg) => !arg.startsWith("--project=")),
      ...executorGroup
        .filter((project) => selectedProjects.has(project))
        .map((project) => `--project=${project}`),
    ];
  } else {
    // The provider index is a logical index retained from the existing workflow.
    bucket = plan.platformMatrix.find(
      (entry) =>
        (projects.includes("provider-native-chromium")
          ? entry.providerShardIndex
          : entry.shardIndex) === index,
    );
    if (!bucket)
      throw new Error(`Shard ${index} is absent from the CI feature plan`);
    files = projects.includes("provider-native-chromium")
      ? bucket.provider
      : bucket.specs;
  }
  if (!files.length) {
    // Provider tests keep --no-deps. Provision their existing isolated user first.
    if (projects.includes("chromium") && bucket?.provider.length)
      return ["--project=setup"];
    return null;
  }
  const filters = files.map(
    (file) => `e2e/tests/${file}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
  );
  return [...args.filter((arg) => !arg.startsWith("--shard=")), ...filters];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const plan = JSON.parse(process.env.CI_FEATURE_PLAN);
    const args = playwrightInvocation(plan, process.argv.slice(2));
    if (args) {
      const result = spawnSync(
        process.execPath,
        ["./node_modules/@playwright/test/cli.js", "test", ...args],
        { stdio: "inherit" },
      );
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    } else {
      console.log(
        "This shard has no planned tests for this project; its other planned checks still run",
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
