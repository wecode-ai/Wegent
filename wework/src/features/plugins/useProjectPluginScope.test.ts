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

function plugin(): InstalledPlugin {
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: { name: 'documents', namespace: 'default', labels: { id: 'documents@openai' } },
    spec: {
      source: { type: 'marketplace', providerKey: 'openai', pluginKey: 'documents' },
      displayName: 'Documents',
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
})
