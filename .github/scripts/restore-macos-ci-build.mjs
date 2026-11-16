import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateMacosRuntimeProducer } from './restore-macos-ci-runtimes.mjs'
import { currentIdentity } from './frontend-e2e-build.mjs'
import {
  archiveName,
  manifestName,
  macosBuild,
  verifyMacosBuild,
  describeMacosBuild,
} from './macos-e2e-build.mjs'

const repository = 'wecode-ai/Wegent'
const root = fileURLToPath(new URL('../../', import.meta.url))

export function validateMacosBuildProducer(run, jobs) {
  const producer = validateMacosRuntimeProducer(run, jobs)
  const job = jobs.find((job) => job.name === 'Wework Desktop macOS E2E')
  assert(Number.isSafeInteger(job.id) && job.id > 0)
  assert.equal(
    job.html_url,
    `https://github.com/${repository}/actions/runs/${run.id}/job/${job.id}`,
  )
  for (const name of [
    'Archive verified complete macOS E2E build',
    'Upload verified complete macOS E2E build',
  ])
    assert.equal(
      job.steps.find((step) => step.name === name)?.conclusion,
      'success',
    )
  return producer
}

async function githubJson(path) {
  assert(process.env.GITHUB_TOKEN, 'GITHUB_TOKEN is required')
  const response = await fetch(
    `https://api.github.com/repos/${repository}/${path}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(30000),
    },
  )
  assert(response.ok, `GitHub API returned ${response.status}`)
  return response.json()
}

function downloadArtifact(run, directory) {
  execFileSync(
    'bash',
    [
      resolve(root, '.github/scripts/download-actions-artifact.sh'),
      'macos-desktop-e2e-build',
      directory,
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        GITHUB_REPOSITORY: repository,
        GITHUB_RUN_ID: String(run.id),
        GITHUB_EVENT_NAME: run.event,
        ACTIONS_ARTIFACT_WORKFLOW: '',
        ACTIONS_ARTIFACT_HEAD_SHA: run.head_sha,
        ACTIONS_ARTIFACT_JOB: 'Wework Desktop macOS E2E',
        ACTIONS_ARTIFACT_WAIT_SECONDS: '0',
      },
    },
  )
}

export async function restoreMacosBuildFromCi(
  runId,
  directory,
  owner,
  {
    json = githubJson,
    download = downloadArtifact,
    metadata = () => macosBuild(root, owner),
  } = {},
) {
  assert.match(String(runId), /^[1-9][0-9]*$/)
  const [run, payload] = await Promise.all([
    json(`actions/runs/${runId}`),
    json(`actions/runs/${runId}/jobs?per_page=100`),
  ])
  assert.equal(run.id, Number(runId))
  const producer = validateMacosBuildProducer(run, payload.jobs)
  download(run, directory)
  assert.deepEqual(
    readdirSync(directory).sort(),
    [archiveName, manifestName].sort(),
    'Unexpected macOS handoff files',
  )
  const expected = metadata()
  const manifest = verifyMacosBuild(directory, expected, {
    headSha: producer.sha,
    runId: String(run.id),
    repository,
  })
  console.log(
    `Verified complete macOS build from ${producer.provenance}, sourceKey=${manifest.sourceKey}, archive-sha256=${manifest.files[0].sha256}, bytes=${manifest.files[0].size}`,
  )
  return { manifest, metadata: expected, producer }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [runId, directory] = process.argv.slice(2)
  const restored = await restoreMacosBuildFromCi(
    runId,
    resolve(directory),
    process.env.GITHUB_REPOSITORY_OWNER,
  )
  // Publication preserves the original build and binds its bytes to this publisher.
  describeMacosBuild(resolve(directory), restored.metadata, currentIdentity(), {
    identity: restored.manifest.verifiedFor,
    job: restored.producer.provenance,
  })
}
