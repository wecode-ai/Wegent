import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  archiveName,
  manifestName,
  verifyBuild,
  currentIdentity,
} from './frontend-e2e-build.mjs'

export const artifactType = 'application/vnd.wegent.frontend-e2e-build.v1'
const execute = (args, options = {}) =>
  execFileSync('oras', args, { encoding: 'utf8', ...options })

export function restoreFrontendBuild(directory, metadata, run = execute) {
  const temporary = mkdtempSync(join(tmpdir(), 'frontend-oci-'))
  const config = join(temporary, 'anonymous.json')
  const artifact = join(temporary, 'artifact')
  writeFileSync(config, '{"auths":{}}')
  const reference = metadata.restoreImage
  try {
    let raw
    try {
      raw = run(['manifest', 'fetch', '--registry-config', config, reference])
    } catch (error) {
      const missing =
        /manifest_unknown|name_unknown|manifest unknown|not found|\bdenied\b/i.test(
          String(error.stderr || error.message),
        )
      if (!reference.includes('@sha256:') && missing) return false
      throw error
    }
    const manifest = JSON.parse(raw)
    assert.equal(
      manifest.artifactType,
      artifactType,
      'Unexpected frontend OCI artifact type',
    )
    assert.deepEqual(
      manifest.layers
        .map((layer) => layer.annotations?.['org.opencontainers.image.title'])
        .sort(),
      [archiveName, manifestName].sort(),
      'Unexpected frontend OCI layer inventory',
    )
    mkdirSync(artifact)
    run(['pull', '--registry-config', config, '--output', artifact, reference])
    assert.deepEqual(
      readdirSync(artifact).sort(),
      [archiveName, manifestName].sort(),
      'Unexpected frontend files',
    )
    verifyBuild(artifact, metadata)
    mkdirSync(directory, { recursive: true })
    for (const name of [archiveName, manifestName])
      copyFileSync(join(artifact, name), join(directory, name))
    return true
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

export function publishFrontendBuild(
  directory,
  metadata,
  identity,
  run = execute,
) {
  verifyBuild(directory, metadata, identity)
  const temporary = mkdtempSync(join(tmpdir(), 'frontend-publish-check-'))
  try {
    if (
      restoreFrontendBuild(
        temporary,
        { ...metadata, restoreImage: metadata.image },
        run,
      )
    ) {
      console.log(`Reused immutable frontend build: ${metadata.image}`)
      return
    }
    run(
      [
        'push',
        '--artifact-type',
        artifactType,
        metadata.image,
        `${archiveName}:application/zstd`,
        `${manifestName}:application/json`,
      ],
      { cwd: directory },
    )
    console.log(`Published immutable frontend build: ${metadata.image}`)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [mode, directory, metadataFile] = process.argv.slice(2)
  const metadata = JSON.parse(readFileSync(metadataFile, 'utf8'))
  if (mode === 'restore') {
    const hit = restoreFrontendBuild(directory, metadata)
    const output = `cache-hit=${hit}\nrestored-image=${hit ? metadata.restoreImage : ''}\n`
    if (process.env.GITHUB_OUTPUT)
      writeFileSync(process.env.GITHUB_OUTPUT, output, { flag: 'a' })
    else process.stdout.write(output)
  } else if (mode === 'publish')
    publishFrontendBuild(directory, metadata, currentIdentity())
  else throw new Error(`Unknown frontend OCI operation: ${mode}`)
}
