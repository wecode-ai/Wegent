import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { InstalledPlugin } from '@/types/api'
import { useProjectPluginScope } from './useProjectPluginScope'

const createDeviceDirectory = vi.fn()
const listWorkspaceEntries = vi.fn()
const readWorkspaceTextFile = vi.fn()
const writeWorkspaceTextFile = vi.fn()

const workbenchValue = {
  state: {
    projects: [
      {
        id: 7,
        name: 'Wegent',
        config: {
          mode: 'workspace',
          execution: { targetType: 'local', deviceId: 'local-device' },
          workspace: { source: 'local_path', localPath: '/work/Wegent' },
        },
        tasks: [],
      },
    ],
    runtimeWork: null,
  },
  getProjectWorkspaceRoot: vi.fn(),
  createDeviceDirectory,
  workspaceFileApi: {
    listWorkspaceEntries,
    readWorkspaceTextFile,
    writeWorkspaceTextFile,
  },
}

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => workbenchValue,
}))

function plugin(name = 'documents'): InstalledPlugin {
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: { name, namespace: 'default', labels: { id: `${name}@openai` } },
    spec: {
      source: { type: 'marketplace', providerKey: 'openai', pluginKey: name },
      displayName: name,
      description: 'Create documents',
      installState: 'installed',
      enabled: false,
      componentStates: {},
      manifest: {},
      components: {
        skills: [],
        commands: [],
        agents: [],
        hooks: [],
        mcps: [],
        lsps: [],
        monitors: [],
        bins: [],
      },
    },
    status: { state: 'disabled' },
  }
}

describe('useProjectPluginScope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listWorkspaceEntries.mockImplementation((_deviceId: string, path: string) =>
      Promise.resolve({
        path,
        entries:
          path === '/work/Wegent'
            ? [{ name: '.codex', path: `${path}/.codex`, isDirectory: true, size: 0 }]
            : [
                {
                  name: 'config.toml',
                  path: `${path}/config.toml`,
                  isDirectory: false,
                  size: 16,
                },
              ],
      })
    )
    readWorkspaceTextFile.mockResolvedValue({
      path: '/work/Wegent/.codex/config.toml',
      name: 'config.toml',
      content: 'model = "gpt-5"\n',
      editable: true,
      revision: 'sha256:before',
      truncated: false,
      size: 16,
    })
    writeWorkspaceTextFile.mockImplementation((_deviceId: string, path: string, content: string) =>
      Promise.resolve({
        path,
        name: 'config.toml',
        content,
        editable: true,
        revision: 'sha256:after',
        truncated: false,
        size: content.length,
      })
    )
  })

  test('adds a marketplace plugin to the native project config', async () => {
    const { result } = renderHook(() => useProjectPluginScope(7))

    await waitFor(() => expect(result.current?.loading).toBe(false))
    await act(async () => {
      await result.current?.addInstalledPlugin(plugin())
    })

    expect(writeWorkspaceTextFile).toHaveBeenCalledWith(
      'local-device',
      '/work/Wegent/.codex/config.toml',
      'model = "gpt-5"\n\n[plugins."documents@openai"]\nenabled = true\n',
      'sha256:before'
    )
    expect(result.current?.pluginKeys).toEqual(new Set(['documents@openai']))
    expect(createDeviceDirectory).not.toHaveBeenCalled()
  })

  test('serializes project config writes so concurrent installs keep both plugins', async () => {
    let revision = 0
    writeWorkspaceTextFile.mockImplementation((_deviceId: string, path: string, content: string) =>
      Promise.resolve({
        path,
        name: 'config.toml',
        content,
        editable: true,
        revision: `sha256:${++revision}`,
        truncated: false,
        size: content.length,
      })
    )
    const { result } = renderHook(() => useProjectPluginScope(7))
    await waitFor(() => expect(result.current?.loading).toBe(false))

    await act(async () => {
      await Promise.all([
        result.current?.addInstalledPlugin(plugin('documents')),
        result.current?.addInstalledPlugin(plugin('github')),
      ])
    })

    const secondWrite = writeWorkspaceTextFile.mock.calls[1]
    expect(secondWrite[0]).toBe('local-device')
    expect(secondWrite[1]).toBe('/work/Wegent/.codex/config.toml')
    expect(secondWrite[2]).toContain('[plugins."documents@openai"]')
    expect(secondWrite[2]).toContain('[plugins."github@openai"]')
    expect(secondWrite[3]).toBe('sha256:1')
    expect(result.current?.pluginKeys).toEqual(new Set(['documents@openai', 'github@openai']))
  })
})
