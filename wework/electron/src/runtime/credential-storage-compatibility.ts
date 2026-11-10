import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReleaseStore } from './release-store.js'

/** In-place migrations need compatible readers; isolated stores leave the rollback data intact. */
export async function assertCredentialStorageCompatibility(
  store: ReleaseStore,
  targetResources: string
): Promise<void> {
  const target = await packageMetadata(targetResources)
  const written = target.weworkCredentialStorageVersion ?? 2
  if (written === 2) return
  if (written !== 3) throw new Error('Unsupported target credential storage format')
  if (target.weworkCredentialStorageMode === 'isolated-copy-once') return
  const activation = await store.activation()
  const source = activation ? await store.read(activation.from) : await store.active()
  if (!source || source.resources === targetResources) return
  const metadata = await packageMetadata(source.resources)
  if (
    metadata.version !== source.version ||
    !metadata.weworkReadableCredentialStorageVersions?.includes(written)
  ) {
    throw new Error('Install the credential-compatible bridge before this security update')
  }
}

async function packageMetadata(resources: string): Promise<{
  version: string
  weworkCredentialStorageVersion?: number
  weworkCredentialStorageMode?: string
  weworkReadableCredentialStorageVersions?: number[]
}> {
  return JSON.parse(await readFile(join(resources, 'app.asar', 'package.json'), 'utf8'))
}
