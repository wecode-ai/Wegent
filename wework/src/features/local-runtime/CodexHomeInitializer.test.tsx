import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { CodexHomeInitializer } from './CodexHomeInitializer'

const localCodexPluginApiMock = vi.hoisted(() => ({
  codexHomeMigrationStatus: vi.fn(),
  initializeCodexHome: vi.fn(),
}))

vi.mock('@/api/local/codexPlugins', () => ({
  createLocalCodexPluginApi: () => localCodexPluginApiMock,
}))

const migrationStatus = {
  weworkCodexHome: '/Users/test/.wegent-executor/codex',
  nativeCodexHome: '/Users/test/.codex',
  weworkCodexHomeExists: true,
  nativeCodexHomeExists: true,
  shouldPromptMigration: true,
}

describe('CodexHomeInitializer', () => {
  beforeEach(() => {
    window.localStorage.clear()
    localCodexPluginApiMock.codexHomeMigrationStatus.mockReset()
    localCodexPluginApiMock.initializeCodexHome.mockReset()
    localCodexPluginApiMock.codexHomeMigrationStatus.mockResolvedValue(migrationStatus)
    localCodexPluginApiMock.initializeCodexHome.mockResolvedValue({
      ...migrationStatus,
      shouldPromptMigration: false,
    })
  })

  test('prompts during app startup when Wework Codex config is missing', async () => {
    render(
      <CodexHomeInitializer>
        <div data-testid="workbench-child" />
      </CodexHomeInitializer>
    )

    expect(await screen.findByTestId('codex-home-initializer-dialog')).toBeInTheDocument()
    expect(screen.queryByTestId('workbench-child')).not.toBeInTheDocument()
  })

  test('creates Wework Codex config with online connectors disabled', async () => {
    render(<CodexHomeInitializer />)

    await screen.findByTestId('codex-home-initializer-dialog')
    expect(
      screen.queryByTestId('codex-home-initializer-remote-apps-checkbox')
    ).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('codex-home-initializer-create-button'))

    await waitFor(() =>
      expect(localCodexPluginApiMock.initializeCodexHome).toHaveBeenCalledWith({
        migrateNativeHome: false,
        remoteAppsEnabled: false,
      })
    )
    expect(window.localStorage.getItem('wework.plugins.codexMigrationDismissed')).toBe('1')
  })

  test('keeps prompting after dismissal when the Wework Codex config is still missing', async () => {
    window.localStorage.setItem('wework.plugins.codexMigrationDismissed', '1')

    render(<CodexHomeInitializer />)

    expect(await screen.findByTestId('codex-home-initializer-dialog')).toBeInTheDocument()
  })

  test('renders children after Codex config has already been initialized', async () => {
    localCodexPluginApiMock.codexHomeMigrationStatus.mockResolvedValue({
      ...migrationStatus,
      shouldPromptMigration: false,
    })

    render(
      <CodexHomeInitializer>
        <div data-testid="workbench-child" />
      </CodexHomeInitializer>
    )

    expect(await screen.findByTestId('workbench-child')).toBeInTheDocument()
    expect(screen.queryByTestId('codex-home-initializer-dialog')).not.toBeInTheDocument()
  })
})
