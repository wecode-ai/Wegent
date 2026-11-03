import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const LIMIT_MS = 600_000;
const MAX_PARALLEL = 8;

function timestamp(value) {
  const result = Date.parse(value);
  assert.ok(Number.isFinite(result), "Missing upgrade verification timestamp");
  return result;
}

function executionDuration(job, now) {
  if (["queued", "waiting", "pending"].includes(job.status)) return 0;
  assert.ok(["in_progress", "completed"].includes(job.status));
  // Queued jobs may already expose started_at. Runner setup is the first
  // recorded execution step, so waiting for a runner cannot inflate this span.
  const steps = job.steps?.filter((step) => step.started_at);
  assert.ok(steps?.length, `Missing execution steps: ${job.name}`);
  const startedAt = Math.min(
    ...steps.map((step) => timestamp(step.started_at)),
  );
  const finishedAt =
    job.status === "completed" ? timestamp(job.completed_at) : now;
  assert.ok(
    finishedAt >= startedAt,
    "Upgrade verification timestamps are reversed",
  );
  return finishedAt - startedAt;
}

export function verifyUpgradeDuration({
  run,
  jobs,
  matrix,
  producerRunId,
  completed = false,
  now = Date.now(),
}) {
  const resolver = jobs.filter(
    (job) => job.name === "Resolve immutable upgrade inputs",
  );
  assert.equal(resolver.length, 1);
  assert.equal(resolver[0].status, "completed");
  assert.equal(resolver[0].conclusion, "success");
  const selected = matrix.include.map((item) => {
    assert.ok(["stable", "beta"].includes(item.channel));
    assert.ok(
      (item.platform === "macos" && item.arch === "arm64") ||
        (item.platform === "windows" && item.arch === "x64"),
    );
    assert.match(
      item.source_version ?? "",
      /^(?:initial|\d+\.\d+\.\d+(?:-beta\.\d+)?)$/,
    );
    const name = `Verify release upgrades (${item.platform}/${item.arch}/${item.channel}/${item.source_version})`;
    const matches = jobs.filter((job) => job.name === name);
    assert.equal(
      matches.length,
      1,
      `Missing or duplicate upgrade verification: ${name}`,
    );
    if (completed) {
      assert.equal(matches[0].status, "completed");
      assert.equal(matches[0].conclusion, "success");
    }
    return matches[0];
  });
  assert.ok(selected.length >= 2 && selected.length <= 256);
  assert.equal(new Set(selected.map((job) => job.name)).size, selected.length);
  if (String(producerRunId) === String(run.id)) {
    const builds = jobs.filter(
      (job) => job.name.startsWith("Build ") && job.conclusion === "success",
    );
    assert.equal(
      builds.length,
      4,
      "A release requires all four completed producer builds",
    );
  }
  const resolverMs = executionDuration(resolver[0], now);
  // Remove external runner waits while retaining the eight-runner resource
  // limit. Recorded execution order determines scheduling for additional waves.
  const slots = Array(MAX_PARALLEL).fill(0);
  const started = selected.filter(
    (job) => !["queued", "waiting", "pending"].includes(job.status),
  );
  const firstStep = (job) =>
    Math.min(
      ...job.steps
        .filter((step) => step.started_at)
        .map((step) => timestamp(step.started_at)),
    );
  for (const job of started.sort(
    (left, right) => firstStep(left) - firstStep(right),
  )) {
    const slot = slots.indexOf(Math.min(...slots));
    slots[slot] += executionDuration(job, now);
  }
  const matrixMs = Math.max(...slots);
  const aggregates = jobs.filter(
    (job) => job.name === "Aggregate complete upgrade verification",
  );
  assert.ok(aggregates.length <= 1, "Duplicate upgrade aggregation");
  if (completed) {
    assert.equal(aggregates.length, 1, "Missing complete upgrade aggregation");
    assert.equal(aggregates[0].status, "completed");
    assert.equal(aggregates[0].conclusion, "success");
  }
  const aggregateMs = aggregates.length
    ? executionDuration(aggregates[0], now)
    : 0;
  const elapsedMs = resolverMs + matrixMs + aggregateMs;
  const reserveMs = completed ? 0 : 15_000;
  assert.ok(
    elapsedMs + reserveMs < LIMIT_MS,
    `Complete upgrade verification exceeded its 10-minute budget: elapsedMs=${elapsedMs}, reserveMs=${reserveMs}`,
  );
  return {
    timing: "execution-without-runner-queues",
    resolverMs,
    matrixMs,
    aggregateMs,
    maxParallel: MAX_PARALLEL,
    elapsedMs,
    limitMs: LIMIT_MS,
    reserveMs,
    completed,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId } = process.env;
  assert.match(repository ?? "", /^[\w.-]+\/[\w.-]+$/);
  assert.match(runId ?? "", /^[1-9]\d*$/);
  const api = (endpoint, paginate = false) =>
    JSON.parse(
      execFileSync(
        "gh",
        ["api", ...(paginate ? ["--paginate", "--slurp"] : []), endpoint],
        { encoding: "utf8" },
      ),
    );
  const base = `repos/${repository}/actions/runs/${runId}`;
  const result = verifyUpgradeDuration({
    run: api(base),
    jobs: api(`${base}/jobs?filter=latest&per_page=100`, true).flatMap(
      (page) => page.jobs,
    ),
    matrix: JSON.parse(process.env.VERIFICATION_MATRIX),
    producerRunId: process.env.UPGRADE_PRODUCER_RUN_ID,
    completed: process.argv.includes("--completed"),
  });
  console.log(
    JSON.stringify({ event: "upgrade-verification-duration", ...result }),
  );
}
