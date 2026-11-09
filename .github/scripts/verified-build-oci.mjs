import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const execute = (args, options = {}) =>
  execFileSync('oras', args, { encoding: 'utf8', ...options })

export function restoreVerifiedBuild(
  directory,
  reference,
  specification,
  run = execute,
) {
  const temporary = mkdtempSync(join(tmpdir(), 'verified-build-oci-'))
  const config = join(temporary, 'anonymous.json')
  const artifact = join(temporary, 'artifact')
  const { archiveName, manifestName, artifactType, verify, label } =
    specification
  const names = [archiveName, manifestName].sort()
  writeFileSync(config, '{"auths":{}}')
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
      `Unexpected ${label} OCI artifact type`,
    )
    assert.deepEqual(
      manifest.layers
        .map((layer) => layer.annotations?.['org.opencontainers.image.title'])
        .sort(),
      names,
      `Unexpected ${label} OCI layer inventory`,
    )
    mkdirSync(artifact)
    run(['pull', '--registry-config', config, '--output', artifact, reference])
    assert.deepEqual(
      readdirSync(artifact).sort(),
      names,
      `Unexpected ${label} files`,
    )
    verify(artifact)
    mkdirSync(directory, { recursive: true })
    for (const name of names)
      copyFileSync(join(artifact, name), join(directory, name))
    return true
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

export function publishVerifiedBuild(
  directory,
  reference,
  specification,
  run = execute,
) {
  specification.verify(directory)
  const temporary = mkdtempSync(join(tmpdir(), 'verified-build-publish-'))
  try {
    if (restoreVerifiedBuild(temporary, reference, specification, run)) {
      console.log(`Reused immutable ${specification.label} build: ${reference}`)
      return
    }
    run(
      [
        'push',
        '--artifact-type',
        specification.artifactType,
        reference,
        `${specification.archiveName}:application/zstd`,
        `${specification.manifestName}:application/json`,
      ],
      { cwd: directory },
    )
    console.log(
      `Published immutable ${specification.label} build: ${reference}`,
    )
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
