import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { resolveDesktopDeviceId } from './desktop-device-id.js'
import { temporaryDirectory } from './test-helpers.js'

describe('desktop device identity', () => {
  test('persists the generated identity across launches', async () => {
    const directory = await temporaryDirectory('desktop-device-id-')
    const dataDirectory = join(directory.path, 'data')
    const executorHome = join(dataDirectory, 'executor')

    const first = await resolveDesktopDeviceId({
      dataDirectory,
      executorHome,
      environment: {},
    })
    const second = await resolveDesktopDeviceId({
      dataDirectory,
      executorHome,
      environment: {},
    })

    expect(first).toMatch(/^electron-/)
    expect(second).toBe(first)
    expect(await readFile(join(dataDirectory, 'desktop-device-id'), 'utf8')).toBe(`${first}\n`)
    await directory.remove()
  })

  test('adopts the dominant identity from existing managed worktrees', async () => {
    const directory = await temporaryDirectory('desktop-device-id-migration-')
    const dataDirectory = join(directory.path, 'data')
    const executorHome = join(dataDirectory, 'executor')
    await mkdir(join(executorHome, 'runtime-work'), { recursive: true })
    await writeFile(
      join(executorHome, 'runtime-work', 'worktrees.json'),
      JSON.stringify({
        records: {
          '/worktree/one': {
            deviceId: 'electron-existing',
            updatedAt: 10,
          },
          '/worktree/two': {
            deviceId: 'electron-existing',
            updatedAt: 20,
          },
          '/worktree/other': {
            deviceId: 'electron-other',
            updatedAt: 30,
          },
          '/worktree/tauri': {
            deviceId: 'local-device',
            updatedAt: 40,
          },
        },
      })
    )

    await expect(
      resolveDesktopDeviceId({
        dataDirectory,
        executorHome,
        environment: {},
      })
    ).resolves.toBe('electron-existing')
    expect(await readFile(join(dataDirectory, 'desktop-device-id'), 'utf8')).toBe(
      'electron-existing\n'
    )
    await directory.remove()
  })

  test('keeps an explicit environment override', async () => {
    const directory = await temporaryDirectory('desktop-device-id-override-')
    const dataDirectory = join(directory.path, 'data')

    await expect(
      resolveDesktopDeviceId({
        dataDirectory,
        executorHome: join(dataDirectory, 'executor'),
        environment: {
          WEGENT_APP_IPC_DEVICE_ID: 'configured-device',
        },
      })
    ).resolves.toBe('configured-device')
    await expect(readFile(join(dataDirectory, 'desktop-device-id'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await directory.remove()
  })
})
