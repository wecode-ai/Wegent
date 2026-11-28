import assert from "node:assert/strict";
import test from "node:test";
import {
  readUpgradeExecutionJobs,
  verifyUpgradeDuration,
} from "./verify-wework-upgrade-duration.mjs";

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
        {
          platform: "macos",
          arch: "arm64",
          channel: "stable",
          source_version: "0.6.3",
        },
        {
          platform: "windows",
          arch: "x64",
          channel: "stable",
          source_version: "0.6.3",
        },
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
        name: "Verify release upgrades (macos/arm64/stable/0.6.3)",
        status: "completed",
        conclusion: "success",
        steps: steps(120_000),
        completed_at: iso(300_000),
      },
      {
        name: "Verify release upgrades (windows/x64/stable/0.6.3)",
        status: "in_progress",
        conclusion: null,
        steps: steps(200_000),
      },
    ],
  };
}

test("waits for GitHub to publish a newly active runner's steps without inventing execution time", async () => {
  const value = fixture();
  let reads = 0;
  let elapsed = 0;
  const jobs = await readUpgradeExecutionJobs(
    () => {
      reads++;
      return value.jobs.map((job, index) =>
        index === 2 && reads === 1 ? { ...job, steps: [] } : job,
      );
    },
    {
      now: () => elapsed,
      wait: async (ms) => {
        elapsed += ms;
      },
    },
  );
  assert.equal(reads, 2);
  assert.equal(verifyUpgradeDuration({ ...value, jobs }).elapsedMs, 210_000);
});

test("unpublished active steps remain a bounded hard failure", async () => {
  const value = fixture();
  value.jobs[2].steps = [];
  let elapsed = 0;
  await assert.rejects(
    readUpgradeExecutionJobs(() => value.jobs, {
      now: () => elapsed,
      wait: async (ms) => {
        elapsed += ms;
      },
    }),
    /GitHub did not publish execution steps/,
  );
  assert.equal(elapsed, 10_000);
  assert.throws(() => verifyUpgradeDuration(value), /Missing execution steps/);
});

test("report-only reads do not wait for unavailable GitHub step telemetry", async () => {
  const value = fixture();
  value.jobs[2].steps = [];
  const jobs = await readUpgradeExecutionJobs(() => value.jobs, {
    requireSteps: false,
    wait: async () =>
      assert.fail("Advisory reporting must not delay package verification"),
  });
  const report = verifyUpgradeDuration({
    ...value,
    jobs,
    enforceBudget: false,
  });
  assert.equal(report.timing, "unavailable");
  assert.equal(report.elapsedMs, null);
  assert.equal(report.withinBudget, null);
  assert.deepEqual(report.missingExecutionJobs, [value.jobs[2].name]);
});

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
  value.jobs.push({
    name: "Aggregate complete upgrade verification",
    status: "completed",
    conclusion: "success",
    steps: steps(800_000),
    completed_at: iso(800_000),
  });
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

test("report-only timing records an exceeded target without accepting invalid evidence", () => {
  const value = fixture();
  value.enforceBudget = false;
  value.now = origin + 900_000;
  const result = verifyUpgradeDuration(value);
  assert.equal(result.withinBudget, false);
  assert.equal(result.enforceBudget, false);
  assert.equal(result.elapsedMs, 710_000);
  value.completed = true;
  assert.throws(() => verifyUpgradeDuration(value));
  value.completed = false;
  value.jobs[1].steps = [];
  assert.equal(verifyUpgradeDuration(value).timing, "unavailable");
});

test("missing telemetry never relaxes completed package verification gates", () => {
  const value = fixture();
  value.enforceBudget = false;
  value.completed = true;
  value.jobs[2].status = "completed";
  value.jobs[2].conclusion = "success";
  value.jobs.push({
    name: "Aggregate complete upgrade verification",
    status: "completed",
    conclusion: "success",
  });
  for (const job of value.jobs) job.steps = [];
  assert.equal(verifyUpgradeDuration(value).timing, "unavailable");
  for (const job of value.jobs) {
    job.conclusion = "failure";
    assert.throws(() => verifyUpgradeDuration(value));
    job.conclusion = "success";
    job.status = "in_progress";
    assert.throws(() => verifyUpgradeDuration(value));
    job.status = "completed";
  }
  value.jobs.pop();
  assert.throws(
    () => verifyUpgradeDuration(value),
    /Missing complete upgrade aggregation/,
  );
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
  value.jobs.push({
    name: "Aggregate complete upgrade verification",
    status: "completed",
    conclusion: "success",
    steps: steps(800_000),
    completed_at: iso(800_000),
  });
  assert.throws(() => verifyUpgradeDuration(value));
});

test("ordinary releases retain all producer gates without counting builds as upgrade execution", () => {
  const value = fixture();
  value.producerRunId = 20;
  value.jobs.push(
    ...[0, 1, 2, 3, 4].map((index) => ({
      name: `Build platform ${index}`,
      conclusion: "success",
      completed_at: iso(100_000 + index * 10_000),
    })),
  );
  assert.equal(verifyUpgradeDuration(value).elapsedMs, 210_000);
  value.jobs.pop();
  assert.throws(
    () => verifyUpgradeDuration(value),
    /five completed producer builds/,
  );
});

test("Windows arm64 shards and the fifth producer build satisfy the release gates", () => {
  const value = fixture();
  value.producerRunId = 20;
  value.matrix.include.push({
    platform: "windows",
    arch: "arm64",
    channel: "stable",
    source_version: "0.6.3",
  });
  value.jobs.push(
    {
      name: "Verify release upgrades (windows/arm64/stable/0.6.3)",
      status: "completed",
      conclusion: "success",
      steps: steps(200_000),
      completed_at: iso(300_000),
    },
    ...[0, 1, 2, 3, 4].map((index) => ({
      name: `Build platform ${index}`,
      conclusion: "success",
      completed_at: iso(100_000 + index * 10_000),
    })),
  );
  assert.equal(verifyUpgradeDuration(value).elapsedMs, 210_000);
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

test("source shards retain the eight-runner cap and count aggregation execution", () => {
  const value = fixture();
  value.matrix.include = [];
  value.jobs = value.jobs.slice(0, 1);
  for (let index = 0; index < 9; index++) {
    const source_version = `0.6.${index}`;
    value.matrix.include.push({
      platform: "windows",
      arch: "x64",
      channel: "stable",
      source_version,
    });
    value.jobs.push({
      name: `Verify release upgrades (windows/x64/stable/${source_version})`,
      status: "completed",
      conclusion: "success",
      steps: steps(100_000 + index * 1_000),
      completed_at: iso(300_000 + index * 1_000),
    });
  }
  value.jobs.push({
    name: "Aggregate complete upgrade verification",
    status: "completed",
    conclusion: "success",
    steps: steps(500_000),
    completed_at: iso(525_000),
  });
  value.completed = true;
  const result = verifyUpgradeDuration(value);
  assert.equal(result.maxParallel, 8);
  assert.equal(result.matrixMs, 400_000);
  assert.equal(result.aggregateMs, 25_000);
  assert.equal(result.elapsedMs, 435_000);
  value.jobs.at(-1).completed_at = iso(700_000);
  assert.throws(() => verifyUpgradeDuration(value), /10-minute budget/);
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
    value.jobs.push({
      name: "Aggregate complete upgrade verification",
      status: "completed",
      conclusion: "success",
      steps: steps(800_000),
      completed_at: iso(800_000),
    });
    Object.assign(value.jobs[2], {
      status: "completed",
      conclusion: "success",
      completed_at: iso(350_000),
    });
    change(value);
    assert.throws(() => verifyUpgradeDuration(value));
  }
});
