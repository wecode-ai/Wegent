import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { create } from 'tar'

export const LEGACY_WINDOWS_COMPONENT_IDS = [
  'coreDsh',
  'weworkCorePlugins',
  'weworkAppStatic',
  'bundledPlugins',
  'executor',
  'codex',
  'dws',
]

export async function prepareWindowsMigrationAssets({ directory, version, arch }) {
  const ticketName = 'migration-ticket.json'
  const ticket = `${JSON.stringify({
    schemaVersion: 2,
    kind: 'windows-update-protocol-migration',
    version,
    platform: 'windows',
    arch,
    target: 'self-contained-installer',
  })}\n`
  const contentSha256 = createHash('sha256').update(ticket).digest('hex')
  const staging = await mkdtemp(join(directory, '.windows-migration-'))
  const temporaryArchive = join(staging, 'ticket.tar.gz')
  try {
    await writeFile(join(staging, ticketName), ticket)
    await create(
      { cwd: staging, file: temporaryArchive, gzip: true, portable: true, mtime: new Date(0) },
      [ticketName]
    )
    const archive = await readFile(temporaryArchive)
    const archiveSha256 = createHash('sha256').update(archive).digest('hex')
    const assetName = `WeworkComponent_windowsMigration_${archiveSha256}_windows_${arch}.tar.gz`
    await writeFile(join(directory, assetName), archive)
    // Old native-path and POSIX-path updaters agree on file SHA-256. These are
    // data-only migration tickets; the complete NSIS package supplies all code.
    const component = {
      version: `windows-migration-${version}`,
      contentSha256,
      archiveSha256,
      assetName,
      releaseScope: 'version',
      entryPath: ticketName,
    }
    const descriptor = {
      schemaVersion: 1,
      appVersion: version,
      platform: 'windows',
      arch,
      legacyMigration: { protocolVersion: 2, kind: 'self-contained-installer' },
      components: Object.fromEntries(LEGACY_WINDOWS_COMPONENT_IDS.map(id => [id, component])),
    }
    await writeFile(
      join(directory, `components-windows-${arch}.json`),
      `${JSON.stringify(descriptor, null, 2)}\n`
    )
    return descriptor
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

export function isLegacyWindowsMigrationDescriptor(manifest) {
  return (
    manifest.platform === 'windows' &&
    manifest.legacyMigration?.protocolVersion === 2 &&
    manifest.legacyMigration.kind === 'self-contained-installer'
  )
}
