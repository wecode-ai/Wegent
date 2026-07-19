import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ProjectSettingsPage } from './ProjectSettingsPage'

const readPluginState = vi.fn()
const upsertMarketplace = vi.fn()
const selectMarketplace = vi.fn()
const installAvailablePlugin = vi.fn()
const updateInstalledPlugin = vi.fn()
const uninstallInstalledPlugin = vi.fn()
const writeWorkspaceTextFile = vi.fn()
const createDeviceDirectory = vi.fn()
const listWorkspaceEntries = vi.fn((_deviceId: string, path: string) =>
  Promise.resolve({
    path,
    entries:
      path === '/work/Wegent'
        ? [
            { name: 'AGENTS.md', path: `${path}/AGENTS.md`, isDirectory: false, size: 10 },
            { name: '.codex', path: `${path}/.codex`, isDirectory: true, size: 0 },
          ]
        : [
            {
              name: 'config.toml',
              path: `${path}/config.toml`,
              isDirectory: false,
              size: 20,
            },
          ],
  })
)
const readWorkspaceTextFile = vi.fn((_deviceId: string, path: string) =>
  Promise.resolve({
    path,
    name: path.split('/').at(-1) ?? '',
    content: path.endsWith('AGENTS.md') ? 'Run focused tests.' : 'model = "gpt-5"\n',
    editable: true,
    revision: path.endsWith('AGENTS.md') ? 'sha256:agents' : 'sha256:config',
    truncated: false,
    size: 20,
  })
)
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
  },
  getProjectWorkspaceRoot: vi.fn(),
  createDeviceDirectory,
  workspaceFileApi: {
    listWorkspaceEntries,
    readWorkspaceTextFile,
    writeWorkspaceTextFile,
  },
}

vi.mock('@/api/local/codexPlugins', () => ({
  createLocalCodexPluginApi: () => ({
    readState: readPluginState,
    upsertMarketplace,
    selectMarketplace,
    installAvailablePlugin,
    updateInstalledPlugin,
    uninstallInstalledPlugin,
  }),
}))

vi.mock('@/lib/runtime-environment', () => ({ isTauriRuntime: () => true }))

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => workbenchValue,
}))

describe('ProjectSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState({}, '', '/')
    uninstallInstalledPlugin.mockResolvedValue(undefined)
    readPluginState.mockResolvedValue({
      installedPlugins: [
        {
          apiVersion: 'v1',
          kind: 'InstalledPlugin',
          metadata: {},
          spec: {
            source: { type: 'marketplace', providerKey: 'openai-bundled', pluginKey: 'sites' },
            displayName: 'Sites',
            description: 'Build sites',
            installState: 'installed',
            enabled: false,
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
          status: { state: 'ready' },
        },
      ],
      marketplaceItems: [],
      marketplaces: [{ id: 'openai-bundled', name: 'OpenAI', path: '/marketplace' }],
      selectedMarketplaceId: 'openai-bundled',
      marketplacePath: '/marketplace',
      installRegistryPath: '',
    })
    writeWorkspaceTextFile.mockImplementation((_deviceId: string, path: string, content: string) =>
      Promise.resolve({
        path,
        name: path.split('/').at(-1) ?? '',
        content,
        editable: true,
        revision: 'sha256:saved',
        truncated: false,
        size: content.length,
      })
    )
  })

  test('edits native instructions and adds an installed plugin to project config', async () => {
    const user = userEvent.setup()
    render(<ProjectSettingsPage projectId={7} />)

    const instructions = await screen.findByTestId('project-settings-instructions-input')
    expect(instructions).toHaveValue('Run focused tests.')
    await user.clear(instructions)
    await user.type(instructions, 'Run all tests before pushing.')
    await user.selectOptions(screen.getByTestId('project-settings-sandbox-mode'), 'workspace-write')
    await user.selectOptions(screen.getByTestId('project-settings-approval-policy'), 'on-request')
    await user.selectOptions(screen.getByTestId('project-settings-web-search'), 'live')
    await user.click(screen.getByTestId('project-plugin-toggle-sites@openai-bundled'))
    await user.click(screen.getByTestId('project-settings-save-button'))

    await waitFor(() => expect(writeWorkspaceTextFile).toHaveBeenCalledTimes(2))
    expect(writeWorkspaceTextFile).toHaveBeenCalledWith(
      'local-device',
      '/work/Wegent/AGENTS.md',
      'Run all tests before pushing.',
      'sha256:agents'
    )
    expect(writeWorkspaceTextFile).toHaveBeenCalledWith(
      'local-device',
      '/work/Wegent/.codex/config.toml',
      'model = "gpt-5"\nsandbox_mode = "workspace-write"\napproval_policy = "on-request"\nweb_search = "live"\n\n[plugins."sites@openai-bundled"]\nenabled = true\n',
      'sha256:config'
    )
  })

  test('does not recreate an existing .codex directory when config is missing', async () => {
    listWorkspaceEntries.mockImplementation((_deviceId: string, path: string) =>
      Promise.resolve({
        path,
        entries:
          path === '/work/Wegent'
            ? [
                {
                  name: 'AGENTS.md',
                  path: `${path}/AGENTS.md`,
                  isDirectory: false,
                  size: 10,
                },
                { name: '.codex', path: `${path}/.codex`, isDirectory: true, size: 0 },
              ]
            : [],
      })
    )
    const user = userEvent.setup()
    render(<ProjectSettingsPage projectId={7} />)

    await screen.findByTestId('project-settings-instructions-input')
    await user.click(screen.getByTestId('project-plugin-toggle-sites@openai-bundled'))
    await user.click(screen.getByTestId('project-settings-save-button'))

    await waitFor(() => expect(writeWorkspaceTextFile).toHaveBeenCalledTimes(1))
    expect(createDeviceDirectory).not.toHaveBeenCalled()
    expect(writeWorkspaceTextFile).toHaveBeenCalledWith(
      'local-device',
      '/work/Wegent/.codex/config.toml',
      '[plugins."sites@openai-bundled"]\nenabled = true\n',
      'missing'
    )
  })

  test('opens the shared plugin marketplace with project context', async () => {
    const user = userEvent.setup()
    render(<ProjectSettingsPage projectId={7} />)

    await user.click(await screen.findByTestId('project-settings-browse-plugins-button'))

    expect(window.location.pathname).toBe('/plugins')
    expect(new URLSearchParams(window.location.search).get('projectId')).toBe('7')
  })

  test('keeps graphical project settings available when plugin discovery fails', async () => {
    readPluginState.mockRejectedValue(new Error('plugin discovery failed'))
    render(<ProjectSettingsPage projectId={7} />)

    expect(await screen.findByTestId('project-settings-instructions-input')).toHaveValue(
      'Run focused tests.'
    )
    expect(await screen.findByTestId('project-settings-plugin-error')).toHaveTextContent(
      'plugin discovery failed'
    )
  })
})
