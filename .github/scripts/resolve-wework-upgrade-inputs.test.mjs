import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveUpgradeInputs,
  upgradeVerificationMatrix,
} from "./resolve-wework-upgrade-inputs.mjs";

function fixture() {
  const environment = {
    SOURCE_RUN_ID: "123",
    GITHUB_REPOSITORY: "wecode-ai/Wegent",
    VERIFICATION_SHA: "a".repeat(40),
    REPLAY: "true",
    PUBLISH_RELEASE: "false",
  };
  const run = {
    repository: { full_name: environment.GITHUB_REPOSITORY },
    path: ".github/workflows/wework-app.yml",
    event: "workflow_dispatch",
  };
  const jobs = ["macOS arm64", "macOS x64", "Windows x64", "Linux x64"].map(
    (platform) => ({ name: `Build ${platform}`, conclusion: "success" }),
  );
  const artifacts = ["macos-arm64", "windows-x64"].map((platform) => ({
    name: `wework-upgrade-input-0.6.4-beta.4-${platform}`,
    expired: false,
    digest: `sha256:${"b".repeat(64)}`,
  }));
  const execute = (_command, args) => {
    const endpoint = args.at(-1);
    return JSON.stringify(
      endpoint.includes("/jobs?")
        ? [{ jobs }]
        : endpoint.includes("/artifacts?")
          ? [{ artifacts }]
          : run,
    );
  };
  return { environment, run, jobs, artifacts, execute };
}

test("reuses successful producers even when an earlier test driver failed", () => {
  const value = fixture();
  value.run.conclusion = "failure";
  assert.deepEqual(resolveUpgradeInputs(value.environment, value.execute), {
    run_id: "123",
    version: "0.6.4-beta.4",
    channel: "beta",
    release_tag: "wework-v0.6.4-beta.4",
    verification_sha: "a".repeat(40),
    diagnostic_checkpoint: "",
    published_release_tag: "",
    verification_matrix: JSON.stringify(upgradeVerificationMatrix("beta")),
  });
});

test("stable verification partitions both channels while beta verification cannot add stable jobs", () => {
  const pairs = (channel, sourceVersion = "") =>
    upgradeVerificationMatrix(channel, sourceVersion).include.map((item) => [
      item.platform,
      item.arch,
      item.channel,
    ]);
  assert.deepEqual(pairs("stable"), [
    ["macos", "arm64", "stable"],
    ["windows", "x64", "stable"],
    ["macos", "arm64", "beta"],
    ["windows", "x64", "beta"],
  ]);
  assert.deepEqual(pairs("beta"), [
    ["macos", "arm64", "beta"],
    ["windows", "x64", "beta"],
  ]);
  assert.deepEqual(pairs("stable", "0.6.4-beta.5"), pairs("beta"));
  assert.deepEqual(pairs("stable", "0.6.3"), [
    ["macos", "arm64", "stable"],
    ["windows", "x64", "stable"],
  ]);
  assert.throws(
    () => upgradeVerificationMatrix("nightly"),
    /Invalid release channel/,
  );
});

test("non-publishing replay only requires the producers whose packages it verifies", () => {
  const value = fixture();
  value.run.conclusion = "failure";
  for (const job of value.jobs) {
    if (["Build macOS x64", "Build Linux x64"].includes(job.name))
      job.conclusion = "failure";
  }
  assert.equal(
    resolveUpgradeInputs(value.environment, value.execute).version,
    "0.6.4-beta.4",
  );
});

for (const platform of ["macOS arm64", "Windows x64"]) {
  test(`replay still requires exactly one successful ${platform} producer`, () => {
    for (const failure of [
      "failure",
      "cancelled",
      "pending",
      "missing",
      "duplicate",
    ]) {
      const value = fixture();
      const job = value.jobs.find((item) => item.name === `Build ${platform}`);
      if (failure === "missing") value.jobs.splice(value.jobs.indexOf(job), 1);
      else if (failure === "duplicate") value.jobs.push({ ...job });
      else job.conclusion = failure === "pending" ? null : failure;
      assert.throws(
        () => resolveUpgradeInputs(value.environment, value.execute),
        new RegExp(`Source producer did not succeed: ${platform}`),
      );
    }
  });
}

test("normal dry runs and publication still require all four producers", () => {
  for (const platform of [
    "macOS arm64",
    "macOS x64",
    "Windows x64",
    "Linux x64",
  ]) {
    for (const publish of ["false", "true"]) {
      const value = fixture();
      value.environment.REPLAY = "false";
      value.environment.PUBLISH_RELEASE = publish;
      value.jobs.find((job) => job.name === `Build ${platform}`).conclusion =
        "failure";
      assert.throws(
        () => resolveUpgradeInputs(value.environment, value.execute),
        new RegExp(`Source producer did not succeed: ${platform}`),
      );
    }
  }
});

test("selects a matching immutable published target only for a replay", () => {
  const value = fixture();
  value.environment.PUBLISHED_RELEASE_TAG = "wework-v0.6.4-beta.4";
  assert.equal(
    resolveUpgradeInputs(value.environment, value.execute)
      .published_release_tag,
    "wework-v0.6.4-beta.4",
  );
  value.environment.PUBLISHED_RELEASE_TAG = "wework-v0.6.4-beta.5";
  assert.throws(
    () => resolveUpgradeInputs(value.environment, value.execute),
    /must match the input artifact version/,
  );
  value.environment.PUBLISHED_RELEASE_TAG = "wework-v0.6.4-beta.4";
  value.environment.REPLAY = "false";
  assert.throws(
    () => resolveUpgradeInputs(value.environment, value.execute),
    /requires an existing build replay/,
  );
});

test("a focused diagnostic is limited to a non-publishing replay", () => {
  const value = fixture();
  value.environment.VERIFICATION_CHECKPOINT = "app-rollback";
  assert.equal(
    resolveUpgradeInputs(value.environment, value.execute)
      .diagnostic_checkpoint,
    "app-rollback",
  );
  value.environment.REPLAY = "false";
  assert.throws(
    () => resolveUpgradeInputs(value.environment, value.execute),
    /requires an existing build replay/,
  );
  value.environment.REPLAY = "true";
  value.environment.VERIFICATION_CHECKPOINT = "unregistered-checkpoint";
  assert.throws(
    () => resolveUpgradeInputs(value.environment, value.execute),
    /requires an existing build replay/,
  );
  value.environment.VERIFICATION_CHECKPOINT = "app-rollback";
  value.environment.PUBLISH_RELEASE = "true";
  assert.throws(
    () => resolveUpgradeInputs(value.environment, value.execute),
    /cannot publish/,
  );
});

test("a refresh diagnostic resolves a separate immutable source without publishing an edge", () => {
  const value = fixture();
  Object.assign(value.environment, {
    REPLAY: "false",
    VERIFICATION_CHECKPOINT: "app-update-refresh",
    VERIFICATION_SOURCE_RUN_ID: "124",
  });
  const execute = (command, args) => {
    const result = value.execute(command, args);
    return args.at(-1).includes("/runs/124/")
      ? result.replaceAll("0.6.4-beta.4", "0.6.4-beta.3")
      : result;
  };
  assert.deepEqual(resolveUpgradeInputs(value.environment, execute), {
    run_id: "123",
    version: "0.6.4-beta.4",
    channel: "beta",
    release_tag: "wework-v0.6.4-beta.4",
    verification_sha: "a".repeat(40),
    diagnostic_checkpoint: "app-update-refresh",
    published_release_tag: "",
    source_run_id: "124",
    source_version: "0.6.4-beta.3",
    verification_matrix: JSON.stringify(
      upgradeVerificationMatrix("beta", "0.6.4-beta.3"),
    ),
  });
  assert.throws(
    () => resolveUpgradeInputs(value.environment, value.execute),
    /must be newer/,
  );
  for (const change of [
    { VERIFICATION_SOURCE_RUN_ID: "" },
    { PUBLISH_RELEASE: "true" },
    { VERIFICATION_CHECKPOINT: "unregistered-checkpoint" },
    { VERIFICATION_SOURCE_RUN_ID: "../124" },
  ]) {
    assert.throws(() =>
      resolveUpgradeInputs({ ...value.environment, ...change }, execute),
    );
  }
  value.jobs[0].conclusion = "failure";
  assert.throws(
    () => resolveUpgradeInputs(value.environment, execute),
    /producer did not succeed/,
  );
});

test("retry diagnostics require an independent source and run on macOS and Windows", () => {
  const value = fixture();
  Object.assign(value.environment, {
    VERIFICATION_CHECKPOINT: "app-update-retry",
    VERIFICATION_SOURCE_RUN_ID: "124",
  });
  const execute = (command, args) => {
    const result = value.execute(command, args);
    return args.at(-1).includes("/runs/124/")
      ? result.replaceAll("0.6.4-beta.4", "0.6.4-beta.3")
      : result;
  };
  const resolved = resolveUpgradeInputs(value.environment, execute);
  assert.equal(resolved.diagnostic_checkpoint, "app-update-retry");
  assert.equal(resolved.source_run_id, "124");
  const roundtrip = resolveUpgradeInputs(
    { ...value.environment, VERIFICATION_CHECKPOINT: "all" },
    execute,
  );
  assert.equal(roundtrip.diagnostic_checkpoint, "upgrade-and-rollback");
  assert.equal(roundtrip.source_run_id, "124");
  assert.deepEqual(
    JSON.parse(resolved.verification_matrix).include.map(
      (item) => item.platform,
    ),
    ["macos", "windows"],
  );
  for (const change of [
    { VERIFICATION_SOURCE_RUN_ID: "" },
    { PUBLISH_RELEASE: "true" },
    { VERIFICATION_CHECKPOINT: "unregistered-checkpoint" },
  ]) {
    assert.throws(() =>
      resolveUpgradeInputs({ ...value.environment, ...change }, execute),
    );
  }
  assert.throws(
    () => resolveUpgradeInputs(value.environment, value.execute),
    /must be newer/,
  );
});

test("rejects publication, invalid provenance, failed producers, and incomplete artifacts", () => {
  const cases = [
    (value) => {
      value.environment.PUBLISH_RELEASE = "true";
    },
    (value) => {
      value.environment.SOURCE_RUN_ID = "../123";
    },
    (value) => {
      value.environment.VERIFICATION_SHA = "main";
    },
    (value) => {
      value.run.repository.full_name = "other/repository";
    },
    (value) => {
      value.run.path = ".github/workflows/test.yml";
    },
    (value) => {
      value.run.event = "pull_request";
    },
    (value) => {
      value.jobs[0].conclusion = "failure";
    },
    (value) => {
      value.artifacts[0].expired = true;
    },
    (value) => {
      value.artifacts[0].digest = null;
    },
    (value) => {
      value.artifacts.pop();
    },
    (value) => {
      value.artifacts.push(value.artifacts[0]);
    },
    (value) => {
      value.artifacts[0].name = value.artifacts[0].name.replace(
        "beta.4",
        "beta.3",
      );
    },
    (value) => {
      value.environment.EXPECTED_VERSION = "0.6.4-beta.5";
    },
  ];
  for (const mutate of cases) {
    const value = fixture();
    mutate(value);
    assert.throws(() => resolveUpgradeInputs(value.environment, value.execute));
  }
});
