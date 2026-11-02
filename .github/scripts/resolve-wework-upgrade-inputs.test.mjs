import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveUpgradeInputs } from "./resolve-wework-upgrade-inputs.mjs";

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
  });
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
