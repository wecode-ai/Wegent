import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ProjectSettingsPage } from './ProjectSettingsPage'

const readPluginState = vi.fn()
const upsertMarketplace = vi.fn()
const selectMarketplace = vi.fn()
const installAvailablePlugin = vi.fn()
const updateInstalledPlugin = vi.fn()
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
  }),
}))

vi.mock('@/lib/runtime-environment', () => ({ isTauriRuntime: () => true }))

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => workbenchValue,
}))

describe('ProjectSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

    const instructions = await screen.findByTestId('project-settings-editor-instructions')
    expect(instructions).toHaveValue('Run focused tests.')
    await user.clear(instructions)
    await user.type(instructions, 'Run all tests before pushing.')
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
      'model = "gpt-5"\n\n[plugins."sites@openai-bundled"]\nenabled = true\n',
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

    await screen.findByTestId('project-settings-editor-instructions')
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

  test('adds a plugin source and installs a catalog plugin for this project', async () => {
    readPluginState.mockResolvedValue({
      installedPlugins: [],
      marketplaceItems: [],
      marketplaces: [],
      selectedMarketplaceId: '',
      marketplacePath: '',
      installRegistryPath: '',
    })
    upsertMarketplace.mockResolvedValue({
      installedPlugins: [],
      marketplaceItems: [
        {
          id: 'documents@openai',
          name: 'Documents',
          description: 'Create and edit documents',
          installed: false,
        },
      ],
      marketplaces: [{ id: 'openai', name: 'OpenAI', path: 'https://github.com/openai/plugins' }],
      selectedMarketplaceId: 'openai',
      marketplacePath: 'https://github.com/openai/plugins',
      installRegistryPath: '',
    })
    installAvailablePlugin.mockResolvedValue({
      apiVersion: 'v1',
      kind: 'InstalledPlugin',
      metadata: { labels: { id: 'documents@openai' } },
      spec: {
        source: { type: 'marketplace', providerKey: 'openai', pluginKey: 'documents' },
        displayName: 'Documents',
        description: 'Create and edit documents',
        installState: 'installed',
        enabled: true,
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
    })
    const user = userEvent.setup()
    render(<ProjectSettingsPage projectId={7} />)

    const source = await screen.findByTestId('project-plugin-marketplace-source')
    await user.type(source, 'https://github.com/openai/plugins')
    await user.click(screen.getByTestId('project-plugin-add-marketplace'))

    expect(upsertMarketplace).toHaveBeenCalledWith({
      path: 'https://github.com/openai/plugins',
    })
    await user.click(await screen.findByTestId('project-plugin-install-documents@openai'))

    expect(installAvailablePlugin).toHaveBeenCalledWith('documents@openai')
    expect(updateInstalledPlugin).toHaveBeenCalledWith('documents@openai', { enabled: false })
    expect(screen.getByTestId('project-plugin-toggle-documents@openai')).toBeChecked()
  })
})
