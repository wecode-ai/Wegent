import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { defaultAppPreferences } from '@/tauri/appPreferences'
import './../../../src/i18n'
import { GitHostingSettingsPage } from './GitHostingSettingsPage'

const getGitHostingCliStatus = vi.hoisted(() => vi.fn())
const updateAppPreferences = vi.hoisted(() => vi.fn())
const copyTextToClipboard = vi.hoisted(() => vi.fn())
const openExternalUrl = vi.hoisted(() => vi.fn())

vi.mock('@/api/gitHostingCli', () => ({
  getGitHostingCliStatus,
}))

vi.mock('@/features/app-preferences/useAppPreferencesState', () => ({
  useAppPreferencesState: () => ({
    loaded: true,
    preferences: defaultAppPreferences,
  }),
}))

vi.mock('@/tauri/appPreferences', async importOriginal => {
  const actual = await importOriginal<typeof import('@/tauri/appPreferences')>()
  return { ...actual, updateAppPreferences }
})

vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard }))
vi.mock('@/lib/external-links', () => ({ openExternalUrl }))

describe('GitHostingSettingsPage', () => {
  beforeEach(() => {
    getGitHostingCliStatus.mockReset()
    updateAppPreferences.mockReset()
    copyTextToClipboard.mockReset()
    openExternalUrl.mockReset()
    updateAppPreferences.mockImplementation(async patch => ({
      ...defaultAppPreferences,
      ...patch,
    }))
    copyTextToClipboard.mockResolvedValue(undefined)
    openExternalUrl.mockResolvedValue(true)
    getGitHostingCliStatus.mockImplementation(async provider =>
      provider === 'github'
        ? {
            provider,
            tool: 'gh',
            installed: true,
            authenticated: false,
            executablePath: '/opt/homebrew/bin/gh',
            version: 'gh version 2.80.0',
          }
        : {
            provider,
            tool: 'glab',
            installed: false,
            authenticated: false,
            executablePath: null,
            version: null,
          }
    )
  })

  test('detects both CLIs and saves the PR/MR status switch', async () => {
    render(<GitHostingSettingsPage />)

    expect(await screen.findByTestId('git-hosting-cli-github-status')).toHaveTextContent('未登录')
    expect(screen.getByTestId('git-hosting-cli-gitlab-status')).toHaveTextContent('未安装')

    await userEvent.click(screen.getByTestId('change-request-status-switch'))
    expect(updateAppPreferences).toHaveBeenCalledWith({ changeRequestStatusEnabled: false })
  })

  test('offers login and installation configuration actions', async () => {
    render(<GitHostingSettingsPage />)
    await screen.findByText('gh version 2.80.0')

    await userEvent.click(screen.getByTestId('git-hosting-cli-github-copy-login'))
    expect(copyTextToClipboard).toHaveBeenCalledWith('gh auth login')

    await userEvent.click(screen.getByTestId('git-hosting-cli-gitlab-install'))
    expect(openExternalUrl).toHaveBeenCalledWith('https://docs.gitlab.com/cli/')
  })

  test('rechecks CLI state on demand', async () => {
    render(<GitHostingSettingsPage />)

    await waitFor(() => expect(getGitHostingCliStatus).toHaveBeenCalledTimes(2))
    await userEvent.click(screen.getByTestId('git-hosting-cli-refresh'))
    await waitFor(() => expect(getGitHostingCliStatus).toHaveBeenCalledTimes(4))
  })
})
