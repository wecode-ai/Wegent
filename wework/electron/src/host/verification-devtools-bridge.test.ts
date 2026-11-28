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

test('the current-instance diagnostics MCP uses a separate credential and exposes no raw CDP', async () => {
  const registryDirectory = await mkdtemp(join(tmpdir(), 'wework-diagnostics-'))
  const bridge = new WeworkDesktopControlBridge({
    instanceId: 'current',
    instanceKind: 'main',
    displayName: 'Test',
    projectRoot: null,
    registryDirectory,
    window: () => null,
    diagnostics: async input => ({ target: input.target, action: input.action }),
  })
  try {
    await bridge.start()
    const { url: WEWORK_DIAGNOSTICS_URL, token: WEWORK_DIAGNOSTICS_TOKEN } = JSON.parse(
      await readFile(bridge.diagnosticsRecordPath()!, 'utf8')
    )
    expect(WEWORK_DIAGNOSTICS_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/diagnostics$/)
    const file = (await readdir(registryDirectory)).find(name => name.endsWith('.json'))!
    const desktop = JSON.parse(await readFile(join(registryDirectory, file), 'utf8'))
    const request = (method: string, params?: object, token = WEWORK_DIAGNOSTICS_TOKEN) =>
      fetch(WEWORK_DIAGNOSTICS_URL!, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
    expect((await request('tools/list', undefined, desktop.token)).status).toBe(401)
    const discovery = await (await request('tools/list')).json()
    expect(discovery.result.tools.map((tool: { name: string }) => tool.name)).toContain(
      'record_renderer'
    )
    const capture = await (
      await request('tools/call', { name: 'record_renderer', arguments: { durationMs: 1_000 } })
    ).json()
    expect(JSON.parse(capture.result.content[0].text)).toEqual({
      target: 'renderer',
      action: 'record',
    })
    const uncheckedCdp = await (
      await request('tools/call', { name: 'Runtime.evaluate', arguments: {} })
    ).json()
    expect(uncheckedCdp.result.isError).toBe(true)
    expect(
      (
        await fetch(new URL('/devtools', WEWORK_DIAGNOSTICS_URL), {
          method: 'POST',
          headers: { authorization: `Bearer ${WEWORK_DIAGNOSTICS_TOKEN}` },
        })
      ).status
    ).toBe(401)
  } finally {
    await bridge.stop()
    await rm(registryDirectory, { recursive: true, force: true })
  }
})
