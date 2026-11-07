// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises'
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

test('the CI plugin flow initiates and holds app/list before opening the local-only picker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'composer-isolation-'))
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
    expect(proxy.release).not.toHaveBeenCalled()
  })
  const control = {
    command: vi.fn(async (action: string) => {
      if (action === 'previewPluginImport') return JSON.stringify({ valid: true })
      if (action === 'getWorkbenchDebugSnapshot')
        return JSON.stringify({ workbench: { currentProject: { id: 'project' } } })
      if (action === 'getComposerPluginInventoryDiagnostics')
        return JSON.stringify({
          composerApps: [{ id: `plugin:${pluginName}` }],
          sharedInventory: { installedPlugins: [{ pluginKey: pluginName, enabled: true }] },
        })
      return 'timed out'
    }),
  }
  try {
    await verifyComposerPluginNetworkIsolation({
      blockingNetworkProxy: proxy,
      codexHome: root,
      control,
      marketplacePath: root,
      restartDesktopApp: vi.fn(),
      workspacePath: root,
    })
    expect(openComposerPluginPicker).toHaveBeenCalledOnce()
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
