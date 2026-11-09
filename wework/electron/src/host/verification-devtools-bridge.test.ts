import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { WeworkDesktopControlBridge } from './wework-desktop-control-bridge.js'
import { VerificationDevtools } from './verification-devtools.js'

test('the host authenticates CDP and does not expose it without verification opt-in', async () => {
  for (const enabled of [false, true]) {
    const registryDirectory = await mkdtemp(join(tmpdir(), 'wework-devtools-'))
    const bridge = new WeworkDesktopControlBridge({
      instanceId: 'test',
      instanceKind: 'main',
      displayName: 'Test',
      projectRoot: null,
      registryDirectory,
      window: () => null,
      ...(enabled ? { devtools: new VerificationDevtools(() => []) } : {}),
    })
    try {
      await bridge.start()
      const [filename] = await readdir(registryDirectory)
      const record = JSON.parse(await readFile(join(registryDirectory, filename), 'utf8'))
      const request = (token: string) =>
        fetch(`http://${record.address}/devtools`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: 'targets' }),
        })
      expect((await request('invalid')).status).toBe(401)
      const response = await request(record.token)
      expect(response.status).toBe(enabled ? 200 : 404)
      if (enabled) expect(await response.json()).toEqual({ ok: true, data: [] })
    } finally {
      await bridge.stop()
      await rm(registryDirectory, { recursive: true, force: true })
    }
  }
})
