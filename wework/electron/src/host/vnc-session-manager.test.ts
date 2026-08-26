import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { VncSessionManager } from './vnc-session-manager.js'

const managers: VncSessionManager[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map(manager => manager.stop()))
  await Promise.all(
    directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  )
})

describe('VncSessionManager', () => {
  test('serves viewer assets and one credential handoff from the loopback bridge', async () => {
    const assets = await mkdtemp(join(tmpdir(), 'wework-vnc-'))
    directories.push(assets)
    await mkdir(join(assets, 'novnc'))
    await writeFile(join(assets, 'vnc.html'), '<html>viewer</html>')
    await writeFile(join(assets, 'novnc', 'rfb.min.js'), 'window.noVNC = {}')
    const manager = new VncSessionManager(assets)
    managers.push(manager)
    await manager.start()
    manager.prepareSession({
      sessionId: '123e4567-e89b-42d3-a456-426614174000',
      wsUrl: 'wss://cloud.example.com/vnc-proxy/device-1',
      token: 'secret',
    })

    const origin = manager.externalBridgeUrl()
    await expect(fetch(`${origin}/vnc.html`).then(response => response.text())).resolves.toContain(
      'viewer'
    )
    await expect(
      fetch(`${origin}/session/123e4567-e89b-42d3-a456-426614174000`).then(response =>
        response.json()
      )
    ).resolves.toEqual({
      wsUrl: 'wss://cloud.example.com/vnc-proxy/device-1',
      token: 'secret',
    })
  })
})
