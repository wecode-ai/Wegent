import assert from "node:assert/strict";
import test from "node:test";
import { verifyUpgradeDuration } from "./verify-wework-upgrade-duration.mjs";

const origin = Date.parse("2026-11-03T10:00:00Z");
const iso = (offset) => new Date(origin + offset).toISOString();
const steps = (offset) => [{ name: "Set up job", started_at: iso(offset) }];

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
        status: "completed",
        conclusion: "success",
        steps: steps(90_000),
        completed_at: iso(100_000),
      },
      {
        name: "Verify release upgrades (macos/arm64/stable)",
        status: "completed",
        conclusion: "success",
        steps: steps(120_000),
        completed_at: iso(300_000),
      },
      {
        name: "Verify release upgrades (windows/x64/stable)",
        status: "in_progress",
        conclusion: null,
        steps: steps(200_000),
      },
    ],
  };
}

test("counts resolver and complete execution of the slowest shard while excluding runner queues", () => {
  const value = fixture();
  const result = verifyUpgradeDuration(value);
  assert.equal(result.resolverMs, 10_000);
  assert.equal(result.matrixMs, 200_000);
  assert.equal(result.elapsedMs, 210_000);
  assert.equal(result.timing, "execution-without-runner-queues");
  value.run.created_at = iso(-3_600_000);
  value.jobs[2].started_at = iso(-3_600_000);
  assert.equal(verifyUpgradeDuration(value).elapsedMs, 210_000);
  value.now = origin + 775_000;
  assert.throws(() => verifyUpgradeDuration(value), /10-minute budget/);
});

test("publication counts setup, downloads, scenarios, cleanup and the final artifact upload", () => {
  const value = fixture();
  value.completed = true;
  Object.assign(value.jobs[2], {
    status: "completed",
    conclusion: "success",
    completed_at: iso(789_000),
  });
  value.jobs[2].steps.push({
    name: "Upload evidence",
    started_at: iso(750_000),
  });
  assert.equal(verifyUpgradeDuration(value).elapsedMs, 599_000);
  value.jobs[2].completed_at = iso(790_000);
  assert.throws(() => verifyUpgradeDuration(value), /10-minute budget/);
});

test("queued shards have no execution yet but cannot authorize completion", () => {
  const value = fixture();
  value.jobs[2] = {
    ...value.jobs[2],
    status: "queued",
    started_at: iso(0),
    steps: [],
  };
  assert.equal(verifyUpgradeDuration(value).elapsedMs, 190_000);
  value.completed = true;
  assert.throws(() => verifyUpgradeDuration(value));
});

test("ordinary releases retain all producer gates without counting builds as upgrade execution", () => {
  const value = fixture();
  value.producerRunId = 20;
  value.jobs.push(
    ...[0, 1, 2, 3].map((index) => ({
      name: `Build platform ${index}`,
      conclusion: "success",
      completed_at: iso(100_000 + index * 10_000),
    })),
  );
  assert.equal(verifyUpgradeDuration(value).elapsedMs, 210_000);
  value.jobs.pop();
  assert.throws(
    () => verifyUpgradeDuration(value),
    /four completed producer builds/,
  );
});

test("all four channel/platform shards contribute to the bounded parallel critical path", () => {
  const value = fixture();
  value.matrix.include.push(
    ...value.matrix.include.map((item) => ({ ...item, channel: "beta" })),
  );
  value.jobs.push(
    ...value.jobs
      .slice(1)
      .map((job) => ({ ...job, name: job.name.replace("stable", "beta") })),
  );
  value.jobs[4] = { ...value.jobs[4], steps: steps(150_000) };
  assert.equal(verifyUpgradeDuration(value).elapsedMs, 260_000);
});

test("missing, failed, duplicate, unfinished or malformed execution records cannot authorize publication", () => {
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
      value.jobs[1].steps[0].started_at = "invalid";
    },
    (value) => {
      value.jobs[1].steps = [];
    },
    (value) => {
      value.jobs[1].completed_at = iso(1);
    },
    (value) => {
      value.jobs[2].status = "in_progress";
    },
  ]) {
    const value = fixture();
    value.completed = true;
    Object.assign(value.jobs[2], {
      status: "completed",
      conclusion: "success",
      completed_at: iso(350_000),
    });
    change(value);
    assert.throws(() => verifyUpgradeDuration(value));
  }
});
