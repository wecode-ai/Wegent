import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { DesktopRelease, ReleaseStore } from './release-store.js'
import { enterInstalledMacosRelease } from './macos-release-installation.js'

afterEach(() => vi.restoreAllMocks())

describe.runIf(process.platform === 'darwin')('legacy macOS release entry', () => {
  test('replaces the legacy child with a native relay instead of re-executing Electron', async () => {
    const execve = vi.spyOn(process, 'execve').mockImplementation(() => {
      throw new Error('native handoff')
    })
    const store = { root: '/isolated/releases' } as ReleaseStore
    const release = {
      id: 'target',
      executable: '/isolated/WeWork.app/Contents/MacOS/WeWork',
      macosInstallation: { payloadExecutable: process.execPath },
    } as DesktopRelease
    const resources = '/isolated/payload/Contents/Resources'
    const launcher = join(resources, 'wework-launcher')

    await expect(
      enterInstalledMacosRelease(store, release, resources, { TEST_ENVIRONMENT: 'retained' })
    ).rejects.toThrow('native handoff')

    expect(execve).toHaveBeenCalledWith(
      launcher,
      [launcher, '--macos-enter', store.root, release.id, ...process.argv.slice(1)],
      { TEST_ENVIRONMENT: 'retained', WEWORK_RELEASE_SUPERVISED: release.id }
    )
  })

  test('rejects an entry that is neither the installed host nor its selected payload', async () => {
    const execve = vi.spyOn(process, 'execve')
    await expect(
      enterInstalledMacosRelease(
        { root: '/isolated/releases' } as ReleaseStore,
        {
          executable: '/isolated/installed/WeWork',
          macosInstallation: { payloadExecutable: '/isolated/payload/WeWork' },
        } as DesktopRelease,
        '/isolated/resources'
      )
    ).rejects.toThrow('not the selected release payload')
    expect(execve).not.toHaveBeenCalled()
  })
})
