import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = "wecode-ai/Wegent";
const root = fileURLToPath(new URL("../../", import.meta.url));

export function validateMacosRuntimeProducer(run, jobs) {
  assert.equal(
    run.repository.full_name.toLowerCase(),
    repository.toLowerCase(),
  );
  assert.equal(run.path, ".github/workflows/wework-e2e.yml");
  assert(["pull_request", "push"].includes(run.event));
  assert.equal(run.status, "completed");
  assert(["success", "failure"].includes(run.conclusion));
  assert.match(run.head_sha, /^[a-f0-9]{40}$/);
  const producers = jobs.filter(
    (job) => job.name === "Wework Desktop macOS E2E",
  );
  assert.equal(producers.length, 1);
  const job = producers[0];
  assert.equal(job.run_id, run.id);
  assert.equal(job.head_sha, run.head_sha);
  assert.equal(job.status, "completed");
  assert.equal(job.conclusion, "success");
  for (const name of [
    "Run Wework desktop macOS Inspector E2E",
    "Describe verified native macOS runtimes",
    "Upload verified macOS Executor runtime",
    "Upload verified macOS Backend runtime",
  ])
    assert.equal(
      job.steps.find((step) => step.name === name)?.conclusion,
      "success",
    );
  return { sha: run.head_sha, provenance: job.html_url };
}

async function request(path) {
  assert(process.env.GITHUB_TOKEN, "GITHUB_TOKEN is required");
  const response = await fetch(
    `https://api.github.com/repos/${repository}/${path}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(30000),
    },
  );
  assert(response.ok, `GitHub API returned ${response.status}`);
  return response.json();
}

async function restore(runId, directory) {
  assert.match(runId ?? "", /^[1-9][0-9]*$/);
  const [run, payload] = await Promise.all([
    request(`actions/runs/${runId}`),
    request(`actions/runs/${runId}/jobs?per_page=100`),
  ]);
  assert.equal(run.id, Number(runId));
  const producer = validateMacosRuntimeProducer(run, payload.jobs);
  mkdirSync(directory, { recursive: true });
  for (const component of ["executor", "backend-rs"]) {
    const digest = execFileSync(
      "node",
      [".github/scripts/macos-e2e-source-digest.mjs", component],
      { cwd: root, encoding: "utf8" },
    ).trim();
    const reference = `ghcr.io/wecode-ai/wegent-wework-macos-e2e-runtime:${component}-v1-${digest}`;
    const binary = resolve(directory, `wegent-${component}`);
    execFileSync(
      "bash",
      [
        ".github/scripts/restore-actions-runtime.sh",
        `macos-${component}-e2e-${component === "executor" ? "binary" : "runtime"}`,
        component,
        `wegent-${component}`,
        reference,
        binary,
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          GITHUB_REPOSITORY: repository,
          GITHUB_RUN_ID: runId,
          GITHUB_EVENT_NAME: run.event,
          ACTIONS_ARTIFACT_WORKFLOW: "",
          ACTIONS_ARTIFACT_HEAD_SHA: producer.sha,
          ACTIONS_ARTIFACT_WAIT_SECONDS: "0",
        },
      },
    );
    const bytes = readFileSync(binary);
    assert.equal(bytes.readUInt32LE(0), 0xfeedfacf, "Expected Mach-O runtime");
    assert.equal(bytes.readUInt32LE(4), 0x0100000c, "Expected arm64 runtime");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const evidence = `${component}: verified ${producer.provenance}, source ${producer.sha}, binary sha256:${sha256}\n`;
    console.log(evidence.trim());
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, evidence);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await restore(process.argv[2], resolve(process.argv[3]));
}
