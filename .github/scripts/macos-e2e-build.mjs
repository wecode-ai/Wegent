import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { currentIdentity } from './frontend-e2e-build.mjs'
import { resolveCiImage } from './resolve-ci-image.mjs'
import {
  publishVerifiedBuild,
  restoreVerifiedBuild,
} from './verified-build-oci.mjs'

export const archiveName = 'wework-macos-e2e-build.tar.zst'
export const manifestName = 'macos-build-manifest.json'
export const artifactType = 'application/vnd.wegent.wework-macos-e2e-build.v1'
const root = fileURLToPath(new URL('../../', import.meta.url))
const context = { platform: 'darwin-arm64', profile: 'desktop-e2e-v1' }

function checkIdentity(identity) {
  assert.match(identity.headSha ?? '', /^[a-f0-9]{40}$/)
  assert.match(String(identity.runId ?? ''), /^\d+$/)
  assert.match(identity.repository ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
}

export function macosBuild(
  directory = root,
  owner = 'wecode-ai',
  digests = {},
) {
  const digest = (component) =>
    digests[component] ||
    execFileSync(
      process.execPath,
      ['.github/scripts/macos-e2e-source-digest.mjs', component],
      { cwd: directory, encoding: 'utf8' },
    ).trim()
  const output = execFileSync(
    'bash',
    [
      '.github/scripts/resolve-wework-macos-e2e-build-ref.sh',
      owner,
      digest('executor'),
      digest('backend-rs'),
    ],
    {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: '/dev/stdout' },
    },
  )
  const image = output.trim().replace(/^reference=/, '')
  assert.match(
    image,
    /^ghcr\.io\/[a-z0-9-]+\/wegent-wework-macos-e2e-runtime:app-v1-[a-f0-9]{64}$/,
  )
  return {
    sourceKey: image.split('v1-')[1],
    context,
    image,
    restoreImage: resolveCiImage(image, directory, 'darwin/arm64'),
  }
}

function inventory(directory) {
  const path = join(directory, archiveName)
  const stat = lstatSync(path)
  assert(
    stat.isFile() && stat.size > 0,
    'Expected a nonempty regular macOS archive',
  )
  // Complete applications can exceed a gigabyte; do not buffer the archive in RAM.
  const fd = openSync(path, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(1024 * 1024)
  try {
    let bytes
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, bytes))
  } finally {
    closeSync(fd)
  }
  return [{ name: archiveName, size: stat.size, sha256: hash.digest('hex') }]
}

export function verifyMacosBuild(directory, metadata, identity) {
  assert(
    lstatSync(join(directory, manifestName)).isFile(),
    'Expected a regular macOS manifest',
  )
  const manifest = JSON.parse(
    readFileSync(join(directory, manifestName), 'utf8'),
  )
  assert.equal(manifest.schema, 1)
  assert.equal(manifest.kind, 'wework-macos-e2e')
  assert.match(manifest.sourceKey ?? '', /^[a-f0-9]{64}$/)
  assert.deepEqual(manifest.context, context, 'macOS build context mismatch')
  checkIdentity(manifest.origin)
  checkIdentity(manifest.verifiedFor)
  if (manifest.validatedProducer) {
    checkIdentity(manifest.validatedProducer.identity)
    const source = manifest.validatedProducer.identity
    assert.equal(source.repository, 'wecode-ai/Wegent')
    assert.match(
      manifest.validatedProducer.job,
      new RegExp(
        `^https://github\\.com/wecode-ai/Wegent/actions/runs/${source.runId}/job/[1-9][0-9]*$`,
      ),
    )
  }
  if (metadata)
    assert.equal(
      manifest.sourceKey,
      metadata.sourceKey,
      'macOS build input mismatch',
    )
  if (identity)
    assert.deepEqual(
      manifest.verifiedFor,
      identity,
      'macOS producer identity mismatch',
    )
  assert.deepEqual(
    manifest.files,
    inventory(directory),
    'macOS archive inventory or SHA256 mismatch',
  )
  return manifest
}

export function describeMacosBuild(
  directory,
  metadata,
  identity,
  validatedProducer,
) {
  checkIdentity(identity)
  const manifest = existsSync(join(directory, manifestName))
    ? verifyMacosBuild(directory, metadata)
    : {
        schema: 1,
        kind: 'wework-macos-e2e',
        sourceKey: metadata.sourceKey,
        context,
        origin: { ...identity },
        files: inventory(directory),
      }
  manifest.verifiedFor = { ...identity }
  if (validatedProducer) manifest.validatedProducer = validatedProducer
  writeFileSync(
    join(directory, manifestName),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  return manifest
}

export const macosSpecification = (metadata) => ({
  archiveName,
  manifestName,
  artifactType,
  label: 'macOS',
  verify: (directory) => verifyMacosBuild(directory, metadata),
})

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [mode, directory = '.ci-artifacts/macos-complete'] =
    process.argv.slice(2)
  const metadata = macosBuild(root, process.env.GITHUB_REPOSITORY_OWNER, {
    executor: process.env.EXECUTOR_SOURCE_DIGEST,
    'backend-rs': process.env.BACKEND_RS_SOURCE_DIGEST,
  })
  const identity = () =>
    currentIdentity({
      ...process.env,
      FRONTEND_HEAD_SHA: process.env.MACOS_HEAD_SHA || '',
    })
  if (mode === 'restore') {
    const hit = restoreVerifiedBuild(
      directory,
      metadata.restoreImage,
      macosSpecification(metadata),
    )
    if (hit) describeMacosBuild(directory, metadata, identity())
    const output = `reference=${metadata.image}\ncache-hit=${hit}\n`
    if (process.env.GITHUB_OUTPUT)
      writeFileSync(process.env.GITHUB_OUTPUT, output, { flag: 'a' })
    else process.stdout.write(output)
  } else if (mode === 'describe') {
    const manifest = describeMacosBuild(directory, metadata, identity())
    console.log(
      `Verified complete macOS build: sourceKey=${manifest.sourceKey}, archive-sha256=${manifest.files[0].sha256}, bytes=${manifest.files[0].size}, producer=${manifest.verifiedFor.repository}@${manifest.verifiedFor.headSha}/${manifest.verifiedFor.runId}`,
    )
  } else if (mode === 'verify')
    verifyMacosBuild(directory, metadata, identity())
  else if (mode === 'publish') {
    verifyMacosBuild(directory, metadata, identity())
    publishVerifiedBuild(
      directory,
      metadata.image,
      macosSpecification(metadata),
    )
  } else throw new Error(`Unknown macOS build operation: ${mode}`)
}
