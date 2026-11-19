import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import type { LocalCodexLocalConfig } from '@/api/local/codexPlugins'
import { PluginSettingsPage } from './PluginSettingsPage'

const mocks = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }))
vi.mock('@/api/local/codexPlugins', () => ({
  createLocalCodexPluginApi: () => ({
    readCodexLocalConfig: mocks.read,
    updateCodexLocalConfig: mocks.save,
  }),
}))
const config: LocalCodexLocalConfig = {
  codexHome: '/codex',
  configPath: '/codex/config.toml',
  remoteAppsEnabled: false,
}
function held<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
const toggle = () => screen.getByTestId('codex-plugin-remote-apps-toggle')
beforeEach(() => {
  vi.resetAllMocks()
  mocks.read.mockResolvedValue(config)
  mocks.save.mockResolvedValue({ ...config, remoteAppsEnabled: true })
})

test('waits for configuration and shows the actual persisted value and path', async () => {
  const pending = held<LocalCodexLocalConfig>()
  mocks.read.mockReturnValue(pending.promise)
  render(<PluginSettingsPage />)
  expect(toggle()).toBeDisabled()
  await act(async () => {
    pending.resolve({ ...config, remoteAppsEnabled: true })
    await pending.promise
  })
  expect(toggle()).toBeEnabled()
  expect(toggle()).toHaveAttribute('aria-checked', 'true')
  expect(screen.getByText('/codex/config.toml')).toBeInTheDocument()
  expect(mocks.save).not.toHaveBeenCalled()
})

test('language changes do not read the same configuration again', async () => {
  const previousLanguage = i18n.language
  const view = render(<PluginSettingsPage />)
  try {
    await waitFor(() => expect(toggle()).toBeEnabled())
    await act(async () => {
      await i18n.changeLanguage(previousLanguage.startsWith('en') ? 'zh-CN' : 'en')
    })
    expect(mocks.read).toHaveBeenCalledOnce()
  } finally {
    view.unmount()
    await act(async () => {
      await i18n.changeLanguage(previousLanguage)
    })
  }
})

test('duplicate clicks start one save and the host receipt remains authoritative', async () => {
  const pending = held<LocalCodexLocalConfig>()
  mocks.save.mockReturnValue(pending.promise)
  render(<PluginSettingsPage />)
  await waitFor(() => expect(toggle()).toBeEnabled())
  act(() => {
    fireEvent.click(toggle())
    fireEvent.click(toggle())
  })
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith({ remoteAppsEnabled: true })
  expect(toggle()).toBeDisabled()
  await act(async () => {
    pending.resolve(config)
    await pending.promise
  })
  expect(toggle()).toBeEnabled()
  expect(toggle()).toHaveAttribute('aria-checked', 'false')
})

test('failed saves retain the previous value and a second action can retry', async () => {
  mocks.save.mockRejectedValueOnce(new Error('write denied'))
  render(<PluginSettingsPage />)
  await waitFor(() => expect(toggle()).toBeEnabled())
  await userEvent.click(toggle())
  expect(screen.getByTestId('codex-plugin-config-error')).toHaveTextContent('write denied')
  expect(toggle()).toHaveAttribute('aria-checked', 'false')
  await userEvent.click(toggle())
  expect(toggle()).toHaveAttribute('aria-checked', 'true')
  expect(screen.queryByTestId('codex-plugin-config-error')).not.toBeInTheDocument()
})

test('late reads and saves cannot change a reopened page', async () => {
  const oldRead = held<LocalCodexLocalConfig>()
  mocks.read.mockReturnValueOnce(oldRead.promise)
  const first = render(<PluginSettingsPage />)
  await waitFor(() => expect(mocks.read).toHaveBeenCalledOnce())
  first.unmount()
  const current = render(<PluginSettingsPage />)
  await waitFor(() => expect(toggle()).toBeEnabled())
  await act(async () => {
    oldRead.resolve({ ...config, remoteAppsEnabled: true })
    await oldRead.promise
  })
  expect(toggle()).toHaveAttribute('aria-checked', 'false')
  const oldSave = held<LocalCodexLocalConfig>()
  mocks.save.mockReturnValueOnce(oldSave.promise)
  await userEvent.click(toggle())
  current.unmount()
  render(<PluginSettingsPage />)
  await waitFor(() => expect(toggle()).toBeEnabled())
  await act(async () => {
    oldSave.resolve({ ...config, remoteAppsEnabled: true })
    await oldSave.promise
  })
  expect(toggle()).toHaveAttribute('aria-checked', 'false')
})

test('an initial read failure is shown and an explicit successful write recovers the view', async () => {
  mocks.read.mockRejectedValueOnce(new Error('read failed'))
  render(<PluginSettingsPage />)
  await screen.findByText('read failed')
  await userEvent.click(toggle())
  expect(toggle()).toHaveAttribute('aria-checked', 'true')
  expect(screen.queryByTestId('codex-plugin-config-error')).not.toBeInTheDocument()
})

test('save failures remain visible and translate without another file read', async () => {
  const previousLanguage = i18n.language
  const view = render(<PluginSettingsPage />)
  try {
    mocks.save.mockRejectedValueOnce(undefined)
    await waitFor(() => expect(toggle()).toBeEnabled())
    await userEvent.click(toggle())
    expect(screen.getByTestId('codex-plugin-config-error')).toHaveTextContent(
      i18n.t('workbench.codex_plugin_config_save_failed')
    )
    await act(async () => {
      await i18n.changeLanguage(previousLanguage.startsWith('en') ? 'zh-CN' : 'en')
    })
    expect(screen.getByTestId('codex-plugin-config-error')).toHaveTextContent(
      i18n.t('workbench.codex_plugin_config_save_failed')
    )
    expect(mocks.read).toHaveBeenCalledOnce()
    expect(mocks.save).toHaveBeenCalledOnce()
  } finally {
    view.unmount()
    await act(async () => {
      await i18n.changeLanguage(previousLanguage)
    })
  }
})

test('publishes the complete saved configuration including its canonical path', async () => {
  mocks.save.mockResolvedValue({
    ...config,
    configPath: '/canonical/config.toml',
    remoteAppsEnabled: true,
  })
  render(<PluginSettingsPage />)
  await waitFor(() => expect(toggle()).toBeEnabled())
  await userEvent.click(toggle())
  expect(screen.getByText('/canonical/config.toml')).toBeInTheDocument()
  expect(screen.queryByText('/codex/config.toml')).not.toBeInTheDocument()
  expect(toggle()).toHaveAttribute('aria-checked', 'true')
})
