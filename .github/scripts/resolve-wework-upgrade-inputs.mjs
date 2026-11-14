import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { releaseVerificationChannels } from "../../wework/scripts/lib/upgrade-evidence.mjs";

import {
  UPGRADE_DIAGNOSTIC_CHECKPOINTS,
  UPGRADE_CHECKPOINT_GROUP,
  isUpgradeSourceDiagnostic,
} from "../../wework/e2e/desktop/upgrade-suite.mjs";
import { compareVersions } from "../../wework/electron/src/runtime/upgrade-policy.mjs";

export function upgradeVerificationMatrix(channel, sourceVersion = "") {
  return {
    include: releaseVerificationChannels(channel, "", sourceVersion).flatMap(
      (selected) => [
        {
          runner: "macos-15",
          platform: "macos",
          arch: "arm64",
          channel: selected,
        },
        {
          runner: "windows-2022",
          platform: "windows",
          arch: "x64",
          channel: selected,
        },
        {
          runner: "windows-11-arm",
          platform: "windows",
          arch: "arm64",
          channel: selected,
        },
      ],
    ),
  };
}

export function resolveUpgradeInputs(environment, execute = execFileSync) {
  const publishedReleaseTag = environment.PUBLISHED_RELEASE_TAG || "";
  if (publishedReleaseTag && environment.REPLAY !== "true")
    throw new Error(
      "A published target selection requires an existing build replay",
    );
  const requestedCheckpoint = environment.VERIFICATION_CHECKPOINT || "all";
  const sourceRunId = environment.VERIFICATION_SOURCE_RUN_ID || "";
  const diagnosticCheckpoint =
    requestedCheckpoint === "all"
      ? sourceRunId
        ? UPGRADE_CHECKPOINT_GROUP
        : ""
      : requestedCheckpoint;
  const requiresSource = isUpgradeSourceDiagnostic(diagnosticCheckpoint);
  if (
    (sourceRunId && !requiresSource) ||
    (requiresSource && !sourceRunId) ||
    (sourceRunId && environment.PUBLISH_RELEASE === "true")
  )
    throw new Error(
      "A prebuilt source requires a non-publishing immutable-pair diagnostic",
    );
  if (
    diagnosticCheckpoint &&
    ((!sourceRunId && environment.REPLAY !== "true") ||
      (diagnosticCheckpoint !== UPGRADE_CHECKPOINT_GROUP &&
        !UPGRADE_DIAGNOSTIC_CHECKPOINTS.includes(diagnosticCheckpoint)))
  )
    throw new Error(
      "A diagnostic checkpoint requires an existing build replay",
    );
  const {
    SOURCE_RUN_ID: runId,
    GITHUB_REPOSITORY: repository,
    VERIFICATION_SHA: verificationSha,
  } = environment;
  if (environment.REPLAY === "true" && environment.PUBLISH_RELEASE === "true")
    throw new Error("Artifact verification cannot publish a release");
  if (!/^[1-9]\d*$/.test(runId ?? "")) throw new Error("Invalid source run ID");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? ""))
    throw new Error("Invalid source repository");
  if (!/^[a-f0-9]{40}$/.test(verificationSha ?? ""))
    throw new Error("Invalid verification source SHA");
  const api = (endpoint, paginate = false) =>
    JSON.parse(
      execute(
        "gh",
        ["api", ...(paginate ? ["--paginate", "--slurp"] : []), endpoint],
        { encoding: "utf8" },
      ),
    );
  const base = `repos/${repository}/actions/runs/${runId}`;
  const run = api(base);
  if (
    run.repository?.full_name !== repository ||
    run.path !== ".github/workflows/wework-app.yml" ||
    run.event !== "workflow_dispatch"
  )
    throw new Error("Source run is not a Wework App release build");
  const jobs = api(`${base}/jobs?filter=latest&per_page=100`, true).flatMap(
    (page) => page.jobs,
  );
  // Replays cannot publish and consume only these three platforms' immutable inputs.
  // Ordinary dry runs and releases retain the complete producer gate.
  const platforms = ["macOS arm64", "Windows x64", "Windows arm64"];
  if (environment.REPLAY !== "true") platforms.push("macOS x64", "Linux x64");
  for (const platform of platforms) {
    const matches = jobs.filter((job) => job.name === `Build ${platform}`);
    if (matches.length !== 1 || matches[0].conclusion !== "success")
      throw new Error(`Source producer did not succeed: ${platform}`);
  }
  const artifacts = api(`${base}/artifacts?per_page=100`, true).flatMap(
    (page) => page.artifacts,
  );
  const versions = new Set();
  for (const platform of ["macos-arm64", "windows-x64", "windows-arm64"]) {
    const candidates = artifacts.filter(
      (artifact) =>
        artifact.name.startsWith("wework-upgrade-input-") &&
        artifact.name.endsWith(`-${platform}`),
    );
    if (
      candidates.length !== 1 ||
      candidates[0].expired ||
      !/^sha256:[a-f0-9]{64}$/.test(candidates[0].digest ?? "")
    )
      throw new Error(`Missing immutable upgrade artifact: ${platform}`);
    versions.add(
      candidates[0].name.slice(
        "wework-upgrade-input-".length,
        -platform.length - 1,
      ),
    );
  }
  if (versions.size !== 1)
    throw new Error("Upgrade artifact versions disagree");
  const [version] = versions;
  if (!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version))
    throw new Error("Invalid artifact version");
  if (environment.EXPECTED_VERSION && version !== environment.EXPECTED_VERSION)
    throw new Error("Artifacts do not match the planned release version");
  if (publishedReleaseTag && publishedReleaseTag !== `wework-v${version}`)
    throw new Error(
      "The published target must match the input artifact version",
    );
  const outputs = {
    run_id: runId,
    version,
    channel: version.includes("-beta.") ? "beta" : "stable",
    verification_matrix: JSON.stringify(
      upgradeVerificationMatrix(version.includes("-beta.") ? "beta" : "stable"),
    ),
    release_tag: `wework-v${version}`,
    verification_sha: verificationSha,
    diagnostic_checkpoint: diagnosticCheckpoint,
    published_release_tag: publishedReleaseTag,
  };
  if (sourceRunId) {
    const source = resolveUpgradeInputs(
      {
        ...environment,
        SOURCE_RUN_ID: sourceRunId,
        VERIFICATION_SOURCE_RUN_ID: "",
        EXPECTED_VERSION: "",
        VERIFICATION_CHECKPOINT: "all",
        PUBLISHED_RELEASE_TAG: "",
        REPLAY: "true",
      },
      execute,
    );
    if (compareVersions(version, source.version) <= 0)
      throw new Error(
        "The diagnostic target must be newer than its immutable source",
      );
    outputs.source_run_id = source.run_id;
    outputs.source_version = source.version;
    outputs.verification_matrix = JSON.stringify(
      upgradeVerificationMatrix(outputs.channel, source.version),
    );
  }
  return outputs;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const outputs = resolveUpgradeInputs(process.env);
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}
