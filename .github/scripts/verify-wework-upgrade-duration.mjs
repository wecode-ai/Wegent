import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const LIMIT_MS = 600_000;

function timestamp(value) {
  const result = Date.parse(value);
  assert.ok(Number.isFinite(result), "Missing upgrade verification timestamp");
  return result;
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
  assert.equal(resolver[0].conclusion, "success");
  const selected = matrix.include.map((item) => {
    assert.ok(["stable", "beta"].includes(item.channel));
    assert.ok(
      (item.platform === "macos" && item.arch === "arm64") ||
        (item.platform === "windows" && item.arch === "x64"),
    );
    const name = `Verify release upgrades (${item.platform}/${item.arch}/${item.channel})`;
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
  assert.ok(selected.length >= 2 && selected.length <= 4);
  assert.equal(new Set(selected.map((job) => job.name)).size, selected.length);
  let startedAt = timestamp(run.created_at);
  if (String(producerRunId) === String(run.id)) {
    const builds = jobs.filter(
      (job) => job.name.startsWith("Build ") && job.conclusion === "success",
    );
    assert.equal(
      builds.length,
      4,
      "A release requires all four completed producer builds",
    );
    startedAt = Math.max(...builds.map((job) => timestamp(job.completed_at)));
  }
  const finishedAt = completed
    ? Math.max(...selected.map((job) => timestamp(job.completed_at)))
    : now;
  const elapsedMs = finishedAt - startedAt;
  assert.ok(elapsedMs >= 0, "Upgrade verification timestamps are reversed");
  const reserveMs = completed ? 0 : 15_000;
  assert.ok(
    elapsedMs + reserveMs < LIMIT_MS,
    `Complete upgrade verification exceeded its 10-minute budget: elapsedMs=${elapsedMs}, reserveMs=${reserveMs}`,
  );
  return {
    startedAt: new Date(startedAt).toISOString(),
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
