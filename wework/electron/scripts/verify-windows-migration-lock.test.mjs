import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import verifyWindowsMigrationLock from './verify-windows-migration-lock.cjs'

const directories = []
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function packagedApp() {
  const directory = await mkdtemp(join(tmpdir(), 'wework-lock-package-test-'))
  directories.push(directory)
  const resources = join(directory, 'resources')
  await mkdir(join(resources, 'bin'), { recursive: true })
  const manifestPath = join(resources, 'components.json')
  const executor = join(resources, 'bin', 'wegent-executor.exe')
  const context = { appOutDir: directory, electronPlatformName: 'win32' }
  await writeFile(
    manifestPath,
    JSON.stringify({
      windowsRuntime: [],
      components: { executor: { path: 'bin/wegent-executor.exe', sha256: 'missing' } },
    })
  )
  return { executor, manifestPath, resources, context }
}

test('rejects a Windows update missing the pre-ready migration executor', async () => {
  const { context } = await packagedApp()
  await expect(verifyWindowsMigrationLock(context)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('rejects a Windows bootstrap binary that differs from the release manifest', async () => {
  const { executor, context } = await packagedApp()
  await writeFile(executor, 'wrong executor')
  await expect(verifyWindowsMigrationLock(context)).rejects.toThrow('checksum mismatch')
})

test('rejects an executor without the migration lock protocol even when its hash matches', async () => {
  const { executor, manifestPath, context } = await packagedApp()
  // Exercise the checksum and real child-process rejection without copying and
  // booting the full Node binary, whose startup dominates this unit test.
  await writeFile(
    executor,
    '#!/bin/sh\nprintf \'%s\\n\' \'{"protocol_version":0,"locked":false}\'\n',
    {
      mode: 0o755,
    }
  )
  const sha256 = createHash('sha256')
    .update(await readFile(executor))
    .digest('hex')
  await writeFile(
    manifestPath,
    JSON.stringify({
      windowsRuntime: [],
      components: { executor: { path: 'bin/wegent-executor.exe', sha256 } },
    })
  )
  await expect(verifyWindowsMigrationLock(context)).rejects.toThrow('failed the startup lock check')
})

test.each(['missing', 'modified'])(
  'rejects a %s app-local runtime before starting the executor',
  async state => {
    const { executor, manifestPath, resources, context } = await packagedApp()
    await writeFile(executor, 'executor')
    const sha256 = createHash('sha256').update('executor').digest('hex')
    await writeFile(
      manifestPath,
      JSON.stringify({
        windowsRuntime: [{ path: 'bin/vcruntime140.dll', sha256 }],
        components: { executor: { path: 'bin/wegent-executor.exe', sha256 } },
      })
    )
    if (state === 'modified')
      await writeFile(join(resources, 'bin', 'vcruntime140.dll'), 'wrong DLL')
    const result = expect(verifyWindowsMigrationLock(context)).rejects
    if (state === 'missing') await result.toMatchObject({ code: 'ENOENT' })
    else await result.toThrow('app-local runtime checksum mismatch')
  }
)

test.each(['darwin', 'linux'])('leaves %s package verification unchanged', async platform => {
  await expect(
    verifyWindowsMigrationLock({ appOutDir: 'unused', electronPlatformName: platform })
  ).resolves.toBeUndefined()
})
