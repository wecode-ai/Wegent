import assert from "node:assert/strict";
import test from "node:test";
import { verifyUpgradeDuration } from "./verify-wework-upgrade-duration.mjs";

const origin = Date.parse("2026-11-03T10:00:00Z");
const iso = (offset) => new Date(origin + offset).toISOString();

function fixture() {
  return {
    run: { id: 20, created_at: iso(0) },
    producerRunId: 10,
    now: origin + 400_000,
    matrix: {
      include: [
        { platform: "macos", arch: "arm64", channel: "stable" },
        { platform: "windows", arch: "x64", channel: "stable" },
      ],
    },
    jobs: [
      {
        name: "Resolve immutable upgrade inputs",
        conclusion: "success",
        started_at: iso(90_000),
      },
      {
        name: "Verify release upgrades (macos/arm64/stable)",
        status: "completed",
        conclusion: "success",
        completed_at: iso(300_000),
      },
      {
        name: "Verify release upgrades (windows/x64/stable)",
        status: "in_progress",
        conclusion: null,
      },
    ],
  };
}

test("replay timing includes resolver and runner queues rather than only the fastest shard", () => {
  assert.equal(verifyUpgradeDuration(fixture()).elapsedMs, 400_000);
  const value = fixture();
  value.now = origin + 590_000;
  assert.throws(() => verifyUpgradeDuration(value), /10-minute budget/);
});

test("publication checks the last completed shard and includes artifact upload time", () => {
  const value = fixture();
  value.completed = true;
  Object.assign(value.jobs[2], {
    status: "completed",
    conclusion: "success",
    completed_at: iso(599_000),
  });
  assert.equal(verifyUpgradeDuration(value).elapsedMs, 599_000);
  value.jobs[2].completed_at = iso(600_000);
  assert.throws(() => verifyUpgradeDuration(value), /10-minute budget/);
});

test("ordinary release timing starts after all builds without excluding subsequent verification waiting", () => {
  const value = fixture();
  value.producerRunId = 20;
  value.jobs.push(
    ...[0, 1, 2, 3].map((index) => ({
      name: `Build platform ${index}`,
      conclusion: "success",
      completed_at: iso(100_000 + index * 10_000),
    })),
  );
  assert.equal(verifyUpgradeDuration(value).elapsedMs, 270_000);
  value.jobs.pop();
  assert.throws(
    () => verifyUpgradeDuration(value),
    /four completed producer builds/,
  );
});

test("missing, failed, duplicate, and unfinished shard records cannot authorize publication", () => {
  for (const change of [
    (value) => value.jobs.pop(),
    (value) => value.jobs.push(value.jobs[1]),
    (value) => {
      value.jobs[1].conclusion = "failure";
    },
    (value) => {
      value.matrix.include[0].channel = "nightly";
    },
    (value) => {
      value.run.created_at = "invalid";
    },
    (value) => {},
  ]) {
    const value = fixture();
    value.completed = true;
    change(value);
    assert.throws(() => verifyUpgradeDuration(value));
  }
});
