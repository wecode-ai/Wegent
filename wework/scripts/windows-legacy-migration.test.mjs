import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extract } from 'tar'
import { afterEach, expect, test } from 'vitest'

import { listComponentAssets } from './desktop-component-release.mjs'
import {
  isLegacyWindowsMigrationDescriptor,
  LEGACY_WINDOWS_COMPONENT_IDS,
  prepareWindowsMigrationAssets,
} from './windows-legacy-migration.mjs'

const directories = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

test('uses one data-only file so native-path and POSIX-path historical updaters agree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-legacy-migration-'))
  directories.push(root)
  const descriptor = await prepareWindowsMigrationAssets({
    directory: root,
    version: '1.2.3',
    arch: 'x64',
  })
  expect(isLegacyWindowsMigrationDescriptor(descriptor)).toBe(true)
  expect(Object.keys(descriptor.components)).toEqual(LEGACY_WINDOWS_COMPONENT_IDS)
  const component = descriptor.components.executor
  const archive = await readFile(join(root, component.assetName))
  expect(createHash('sha256').update(archive).digest('hex')).toBe(component.archiveSha256)
  const extracted = join(root, 'extracted')
  await mkdir(extracted)
  await extract({ file: join(root, component.assetName), cwd: extracted, strict: true })
  expect(await readdir(extracted)).toEqual(['migration-ticket.json'])
  const ticket = await readFile(join(extracted, component.entryPath))
  expect(createHash('sha256').update(ticket).digest('hex')).toBe(component.contentSha256)
  expect(JSON.parse(ticket.toString())).toMatchObject({
    kind: 'windows-update-protocol-migration',
    version: '1.2.3',
    target: 'self-contained-installer',
  })
  for (const component of Object.values(descriptor.components)) {
    expect(component.entryPath).toBe('migration-ticket.json')
    expect(component.releaseScope).toBe('version')
  }
  expect(await listComponentAssets(root, 'shared')).toEqual([])
  expect(await listComponentAssets(root, 'version')).toEqual([component.assetName])
})

test('does not classify a normal component feed as the frozen migration bridge', () => {
  expect(isLegacyWindowsMigrationDescriptor({ platform: 'windows', schemaVersion: 1 })).toBe(false)
  expect(
    isLegacyWindowsMigrationDescriptor({
      platform: 'macos',
      legacyMigration: { protocolVersion: 2, kind: 'self-contained-installer' },
    })
  ).toBe(false)
})
