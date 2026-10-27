import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { normalizeInstallationRoot, VersionUpdateHealth } from './version-installation.js'
import {
  assertCoreDshStartupPluginsReady,
  CoreDshStartupPluginError,
} from './core-dsh-startup-failure.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

test.each(['runtime', 'renderer'])(
  'confirms candidate only after both startup gates, %s first',
  async first => {
    const root = await mkdtemp(join(tmpdir(), 'wework-version-health-'))
    roots.push(root)
    const env = {
      WEWORK_UPDATE_INSTALL_ROOT: root,
      WEWORK_UPDATE_TRANSACTION_ID: 'transaction-1',
      WEWORK_UPDATE_HEALTH_TOKEN: 'private-capability',
    }
    const gate = new VersionUpdateHealth(
      { root, launcher: join(root, 'WeWork.exe'), version: '0.6.0' },
      env
    )
    expect(env).toEqual({})
    await (first === 'runtime' ? gate.markRuntimeReady() : gate.markRendererReady())
    await expect(readdir(join(root, '.updates'))).rejects.toMatchObject({ code: 'ENOENT' })
    await (first === 'runtime' ? gate.markRendererReady() : gate.markRuntimeReady())
    const path = join(root, '.updates', 'health', 'transaction-1.json')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      schemaVersion: 2,
      transactionId: 'transaction-1',
      token: 'private-capability',
    })
    await Promise.all([gate.markRendererReady(), gate.markRuntimeReady()])
    expect(await readdir(join(root, '.updates', 'health'))).toEqual(['transaction-1.json'])
  }
)

test('refuses a forged or escaped startup capability', () => {
  expect(
    () =>
      new VersionUpdateHealth(null, {
        WEWORK_UPDATE_TRANSACTION_ID: '../escape',
        WEWORK_UPDATE_HEALTH_TOKEN: 'token',
      })
  ).toThrow('Invalid update startup capability')
})

test('matches Windows canonical extended paths and drive-letter aliases', () => {
  expect(normalizeInstallationRoot('C:\\Users\\Test\\WeWork', 'win32')).toBe(
    normalizeInstallationRoot('\\\\?\\c:\\users\\test\\WeWork', 'win32')
  )
  expect(normalizeInstallationRoot('\\\\server\\share\\WeWork', 'win32')).toBe(
    normalizeInstallationRoot('\\\\?\\UNC\\server\\share\\wework', 'win32')
  )
  expect(normalizeInstallationRoot('C:\\Users\\Test\\Other', 'win32')).not.toBe(
    normalizeInstallationRoot('\\\\?\\C:\\Users\\Test\\WeWork', 'win32')
  )
})

test.each(['runtime', 'renderer'])(
  'a startup failure permanently blocks confirmation when %s was ready first',
  async first => {
    const { root, gate } = await trialHealth()
    await (first === 'runtime' ? gate.markRuntimeReady() : gate.markRendererReady())
    gate.markFailed()
    await Promise.all([gate.markRendererReady(), gate.markRuntimeReady()])
    await expect(readdir(join(root, '.updates'))).rejects.toMatchObject({ code: 'ENOENT' })
  }
)

test('a detected plugin failure rejects runtime startup before health or readiness is committed', async () => {
  const { root, gate } = await trialHealth()
  const publishRuntimeReady = vi.fn()
  await gate.markRendererReady()

  const startup = gate.completeRuntimeStartup(async () => {
    await assertCoreDshStartupPluginsReady(
      { executeJavaScript: async () => '@wegent/broken-plugin' },
      ['@wegent/broken-plugin']
    )
    publishRuntimeReady()
  })

  await expect(startup).rejects.toMatchObject({
    name: 'CoreDshStartupPluginError',
    pluginName: '@wegent/broken-plugin',
    message: 'Core DSH plugin failed to load: @wegent/broken-plugin',
  })
  expect(publishRuntimeReady).not.toHaveBeenCalled()
  // A later ready event cannot clear the failure of this candidate process.
  await Promise.all([gate.markRendererReady(), gate.markRuntimeReady()])
  await expect(readdir(join(root, '.updates'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('successful primary renderer validation completes the same runtime startup contract', async () => {
  const { root, gate } = await trialHealth()
  await gate.markRendererReady()
  await gate.completeRuntimeStartup(async () => {
    await assertCoreDshStartupPluginsReady({ executeJavaScript: async () => null }, ['plugin'])
  })
  expect(await readdir(join(root, '.updates', 'health'))).toEqual(['transaction-1.json'])
})

test('plugin startup failures retain their diagnostic identity', () => {
  const error = new CoreDshStartupPluginError('plugin')
  expect(error).toBeInstanceOf(Error)
  expect(error.pluginName).toBe('plugin')
})

async function trialHealth(): Promise<{ root: string; gate: VersionUpdateHealth }> {
  const root = await mkdtemp(join(tmpdir(), 'wework-version-health-'))
  roots.push(root)
  return {
    root,
    gate: new VersionUpdateHealth(
      { root, launcher: join(root, 'WeWork.exe'), version: '0.6.0' },
      {
        WEWORK_UPDATE_INSTALL_ROOT: root,
        WEWORK_UPDATE_TRANSACTION_ID: 'transaction-1',
        WEWORK_UPDATE_HEALTH_TOKEN: 'private-capability',
      }
    ),
  }
}
