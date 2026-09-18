import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeComposerCatalogSnapshot } from '@wegent/chat-core/runtime-composer-snapshot'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTaskComposerCatalog } from './useTaskComposerCatalog'

const translate = (key: string) => key
function snapshot(taskId: string): RuntimeComposerCatalogSnapshot {
  return {
    taskId,
    workspacePath: '/workspace',
    projectPluginIds: [],
    apps: [],
    skills: [{ name: taskId, path: `/workspace/${taskId}/SKILL.md` }],
    marketplaces: [
      {
        name: 'tools',
        plugins: [
          {
            id: taskId,
            name: taskId,
            enabled: true,
            installed: true,
            source: { path: '/plugins/tool' },
            interface: { logo: '/plugins/tool/icon.svg' },
          },
        ],
      },
    ],
    store: { storePath: '/store', plugins: [] },
    cloudInstalledPlugins: [],
  }
}
function services(readCatalog = vi.fn().mockResolvedValue(snapshot('one'))) {
  return {
    composerCatalogApi: { readCatalog },
    deviceApi: {
      readWorkspaceFileChunk: vi.fn().mockResolvedValue({
        offset: 0,
        size: 6,
        contentBase64: 'PHN2Zy8+',
        eof: true,
      }),
    },
  } as unknown as WorkbenchServices
}
describe('side task composer catalog', () => {
  it('coalesces picker and slash reads and resolves icons from the bound device', async () => {
    const api = services()
    const { result } = renderHook(() =>
      useTaskComposerCatalog({ deviceId: 'remote', taskId: 'one' }, api, translate)
    )
    const [apps, skills] = await Promise.all([
      result.current.listApps!(),
      result.current.listSkills!(),
    ])
    expect(api.composerCatalogApi!.readCatalog).toHaveBeenCalledTimes(1)
    expect(api.composerCatalogApi!.readCatalog).toHaveBeenCalledWith(
      { deviceId: 'remote', taskId: 'one' },
      true
    )
    expect(api.deviceApi.readWorkspaceFileChunk).toHaveBeenCalledWith(
      'remote',
      '/plugins/tool/icon.svg',
      0,
      '/plugins/tool'
    )
    expect(api.deviceApi.readWorkspaceFileChunk).toHaveBeenCalledTimes(1)
    expect(apps[0].logoUrl).toBe('data:image/svg+xml;base64,PHN2Zy8+')
    expect(skills[0].name).toBe('one')
    expect(result.current.prefetchLocalAuth).toBe(false)
  })

  it('isolates late responses and stores across tasks and does not re-read on ordinary renders', async () => {
    let settle!: (snapshot: RuntimeComposerCatalogSnapshot) => void
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<RuntimeComposerCatalogSnapshot>(resolve => {
            settle = resolve
          })
      )
      .mockResolvedValue(snapshot('two'))
    const api = services(read)
    const { result, rerender } = renderHook(
      ({ taskId }) => useTaskComposerCatalog({ deviceId: 'remote', taskId }, api, translate),
      { initialProps: { taskId: 'one' } }
    )
    const old = result.current
    const oldRequest = old.listApps!().then(apps => old.appsStore.replace(apps))
    rerender({ taskId: 'two' })
    const next = result.current
    await act(async () => next.appsStore.replace(await next.listApps!()))
    settle(snapshot('one'))
    await oldRequest
    expect(next.appsStore.get().map(app => app.id)).toEqual(['plugin:two'])
    expect(old.appsStore.get().map(app => app.id)).toEqual(['plugin:one'])
    rerender({ taskId: 'two' })
    expect(result.current).toBe(next)
    expect(read).toHaveBeenCalledTimes(2)
  })
})
