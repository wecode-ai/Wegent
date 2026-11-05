import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { frontendBuild, verifyBuild } from './frontend-e2e-build.mjs'

const repository = 'wecode-ai/Wegent'
const root = fileURLToPath(new URL('../../', import.meta.url))
async function githubJson(path) {
  const response = await fetch(
    `${process.env.GITHUB_API_URL || 'https://api.github.com'}${path}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
      },
    },
  )
  assert(
    response.ok,
    `GitHub source request failed: ${response.status} ${path}`,
  )
  return response.json()
}
function downloadArtifact(run, directory) {
  execFileSync(
    'bash',
    [
      resolve(root, '.github/scripts/download-actions-artifact.sh'),
      'frontend-next-build',
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
        ACTIONS_ARTIFACT_JOB: 'Build Frontend E2E Artifact',
        ACTIONS_ARTIFACT_WAIT_SECONDS: '0',
      },
    },
  )
}

export async function restoreFrontendFromCi(
  runId,
  directory,
  owner,
  { json = githubJson, download = downloadArtifact, checkoutRoot = root } = {},
) {
  assert.match(
    String(runId),
    /^\d+$/,
    'A numeric frontend source run is required',
  )
  const run = await json(`/repos/${repository}/actions/runs/${runId}`)
  assert.equal(run.id, Number(runId))
  assert.equal(run.path, '.github/workflows/e2e-tests.yml')
  assert.equal(run.repository?.full_name, repository)
  assert.equal(run.status, 'completed')
  assert(
    ['success', 'failure'].includes(run.conclusion),
    'Source workflow was not fully executed',
  )
  const jobs = await json(
    `/repos/${repository}/actions/runs/${runId}/jobs?per_page=100`,
  )
  const producers = jobs.jobs.filter(
    (job) => job.name === 'Build Frontend E2E Artifact',
  )
  assert.equal(producers.length, 1)
  const producer = producers[0]
  assert.equal(producer.run_id, run.id)
  assert.equal(producer.head_sha, run.head_sha)
  assert.equal(producer.status, 'completed')
  assert.equal(
    producer.conclusion,
    'success',
    'Frontend source producer failed',
  )
  download(run, directory)
  const identity = {
    headSha: run.head_sha,
    runId: String(run.id),
    repository,
  }
  const manifest = verifyBuild(directory, undefined, identity)
  // Publication transfers an existing build; its host did not compile this output.
  const metadata = frontendBuild(checkoutRoot, owner, manifest.context)
  verifyBuild(directory, metadata, identity)
  console.log(
    `Verified frontend source producer ${producer.id} at ${run.head_sha}, sourceKey=${manifest.sourceKey}`,
  )
  return { manifest, metadata }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [runId, directory, metadataFile] = process.argv.slice(2)
  const { metadata } = await restoreFrontendFromCi(
    runId,
    directory,
    process.env.GITHUB_REPOSITORY_OWNER,
  )
  writeFileSync(metadataFile, `${JSON.stringify(metadata)}\n`)
}
