import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { WeworkDesktopControlBridge } from './wework-desktop-control-bridge.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('WeworkDesktopControlBridge', () => {
  test('registers an authenticated generic desktop instance and removes it on stop', async () => {
    const registryDirectory = await mkdtemp(join(tmpdir(), 'wework-control-'))
    directories.push(registryDirectory)
    const executeJavaScript = vi.fn(async code => ({
      ok: true,
      inspected: code.includes('__WEWORK_INSPECT_OPTIONS__') === false,
    }))
    const bridge = new WeworkDesktopControlBridge({
      instanceId: 'plugin-development-example',
      instanceKind: 'core-dsh-plugin-development',
      displayName: 'Example',
      projectRoot: '/workspace/example',
      registryDirectory,
      window: () =>
        ({
          focus: vi.fn(),
          isFocused: () => false,
          isMinimized: () => false,
          isVisible: () => true,
          restore: vi.fn(),
          show: vi.fn(),
          webContents: {
            capturePage: vi.fn(async () => ({ toDataURL: () => 'data:image/png;base64,AA==' })),
            executeJavaScript,
            getTitle: () => 'Wework',
            getURL: () => 'http://127.0.0.1/workbench',
            isDestroyed: () => false,
          },
        }) as never,
    })

    await bridge.start()
    const [filename] = await readdir(registryDirectory)
    const record = JSON.parse(await readFile(join(registryDirectory, filename), 'utf8'))
    const headers = { Authorization: `Bearer ${record.token}` }

    const status = await fetch(`http://${record.address}/status`, { headers }).then(response =>
      response.json()
    )
    expect(status).toMatchObject({
      ok: true,
      data: {
        instanceId: 'plugin-development-example',
        projectRoot: '/workspace/example',
        ready: true,
      },
    })

    const inspect = await fetch(`http://${record.address}/desktop`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'inspect' }),
    }).then(response => response.json())
    expect(inspect).toMatchObject({ ok: true, data: { ok: true, inspected: true } })
    expect(executeJavaScript).toHaveBeenCalledOnce()

    await bridge.stop()
    await expect(readdir(registryDirectory)).resolves.toEqual([])
  })
})
