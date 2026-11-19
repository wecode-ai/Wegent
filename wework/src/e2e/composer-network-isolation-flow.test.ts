// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { verifyComposerPluginNetworkIsolation } from '../../e2e/desktop/modules/plugin-flows.mjs'
import { requestExecutor } from '../../e2e/desktop/modules/executor-rpc.mjs'
import { openComposerPluginPicker } from '../../e2e/desktop/modules/conversation-layout.mjs'

vi.mock('../../e2e/desktop/modules/executor-rpc.mjs', () => ({ requestExecutor: vi.fn() }))
vi.mock('../../e2e/desktop/modules/zip-fixtures.mjs', () => ({ createZipFixture: vi.fn() }))
vi.mock('../../e2e/desktop/modules/conversation-layout.mjs', async importOriginal => ({
  ...(await importOriginal<object>()),
  openComposerPluginPicker: vi.fn(),
  closeComposerPluginPicker: vi.fn(),
  waitForSnapshot: vi.fn(async (_control, predicate) => {
    expect(
      predicate({
        testIds: ['composer-plugin-picker-item-plugin:composer-network-isolation-plugin'],
      })
    ).toBe(true)
  }),
}))
vi.mock('../../e2e/desktop/modules/workspace-flows.mjs', async importOriginal => ({
  ...(await importOriginal<object>()),
  captureVerificationScreenshot: vi.fn(),
  waitForControlValueIncludes: vi.fn(),
}))

test.each(['success', 'seed failure'])('the CI plugin flow handles %s', async outcome => {
  vi.clearAllMocks()
  const root = await mkdtemp(join(tmpdir(), 'composer-isolation-'))
  const seedFailure = new Error('Unable to write the isolated catalog')
  const read = Promise.withResolvers<unknown>()
  const proxy = {
    url: 'http://127.0.0.1:1',
    requests: [] as string[],
    block: vi.fn(),
    release: vi.fn(() => read.resolve({})),
  }
  const pluginName = 'composer-network-isolation-plugin'
  vi.mocked(requestExecutor).mockImplementation(async () => {
    proxy.requests.push('CONNECT chatgpt.com:443')
    return read.promise
  })
  vi.mocked(openComposerPluginPicker).mockImplementation(async () => {
    expect(requestExecutor).toHaveBeenCalledOnce()
    if (vi.mocked(openComposerPluginPicker).mock.calls.length === 1)
      expect(proxy.release).not.toHaveBeenCalled()
    else expect(proxy.release).toHaveBeenCalledOnce()
  })
  const control = {
    command: vi.fn(async (action: string, _selector?: string, options?: { value?: string }) => {
      if (action === 'previewPluginImport') return JSON.stringify({ valid: true })
      if (action === 'getWorkbenchDebugSnapshot')
        return JSON.stringify({ workbench: { currentProject: { id: 'project' } } })
      if (action === 'getLocalExecutorStatus') return JSON.stringify({ deviceId: 'test-device' })
      if (action === 'getLocalStorageItem' && options?.value === 'wework.cloudConnection')
        return JSON.stringify({ apiBaseUrl: 'https://wework.example.test/api', user: { id: 1 } })
      if (action === 'getLocalStorageItem' && options?.value === 'wework.plugins.openAiCatalog.v1')
        return ''
      if (action === 'getComposerPluginInventoryDiagnostics')
        return JSON.stringify({
          composerApps: [{ id: `plugin:${pluginName}` }],
          sharedInventory: { installedPlugins: [{ pluginKey: pluginName, enabled: true }] },
        })
      return 'timed out'
    }),
  }
  try {
    const storagePath = join(root, 'renderer-local-storage.json')
    const catalogPath = join(root, 'plugin-cache', 'openai-official-catalog.json')
    await writeFile(storagePath, JSON.stringify({ version: 1, entries: {} }))
    const verification = verifyComposerPluginNetworkIsolation({
      blockingNetworkProxy: proxy,
      codexHome: root,
      control,
      electronUserDataDirectory: root,
      marketplacePath: root,
      restartDesktopApp: async (afterStop: () => Promise<void>) => {
        if (outcome === 'seed failure') throw seedFailure
        await afterStop()
        expect(JSON.parse(await readFile(catalogPath, 'utf8'))).toMatchObject({
          version: 1,
          items: [{ id: 'cached-documents@openai-curated-remote' }],
        })
      },
      workspacePath: root,
    })
    if (outcome === 'seed failure') {
      await expect(verification).rejects.toBe(seedFailure)
      await expect(readFile(join(root, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(control.command).toHaveBeenCalledWith('setLocalProxyUrl', 'body', { value: '' })
      return
    }
    await verification
    const storage = JSON.parse(await readFile(storagePath, 'utf8'))
    expect(storage.entries).toEqual({})
    await expect(readFile(catalogPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(openComposerPluginPicker).toHaveBeenCalledTimes(2)
    expect(control.command).toHaveBeenCalledWith('navigate', 'body', { value: '/' })
    expect(control.command).toHaveBeenCalledWith(
      'waitFor',
      '[data-testid="composer-plugin-picker-item-plugin:composer-network-isolation-plugin"]'
    )
    expect(proxy.block).toHaveBeenCalledTimes(2)
    expect(proxy.release).toHaveBeenCalledTimes(2)
    expect(control.command).toHaveBeenCalledWith(
      'deleteLocalPluginPackage',
      'body',
      expect.any(Object)
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
