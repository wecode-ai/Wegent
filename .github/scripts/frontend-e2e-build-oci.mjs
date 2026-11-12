import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  archiveName,
  manifestName,
  verifyBuild,
  currentIdentity,
} from './frontend-e2e-build.mjs'
import {
  restoreVerifiedBuild,
  publishVerifiedBuild,
} from './verified-build-oci.mjs'

export const artifactType = 'application/vnd.wegent.frontend-e2e-build.v1'
const specification = (metadata, identity) => ({
  archiveName,
  manifestName,
  artifactType,
  label: 'frontend',
  verify: (directory) => verifyBuild(directory, metadata, identity),
})

export function restoreFrontendBuild(directory, metadata, run) {
  return restoreVerifiedBuild(
    directory,
    metadata.restoreImage,
    specification(metadata),
    run,
  )
}

export function publishFrontendBuild(directory, metadata, identity, run) {
  verifyBuild(directory, metadata, identity)
  return publishVerifiedBuild(
    directory,
    metadata.image,
    specification(metadata),
    run,
  )
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
