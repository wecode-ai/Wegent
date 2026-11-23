import i18n from '@/i18n'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import { defaultAppPreferences } from '@/desktop/appPreferences'
import { ContextSettingsPage } from './ContextSettingsPage'

const mocks = vi.hoisted(() => ({
  preferences: vi.fn(),
  update: vi.fn(),
  instructions: vi.fn(),
  saveInstructions: vi.fn(),
}))
vi.mock('@/desktop/appPreferences', async importOriginal => ({
  ...(await importOriginal<typeof import('@/desktop/appPreferences')>()),
  getAppPreferences: mocks.preferences,
  updateAppPreferences: mocks.update,
}))
vi.mock('@/api/local/codexInstructions', () => ({
  getLocalCodexInstructions: mocks.instructions,
  saveLocalCodexInstructions: mocks.saveInstructions,
}))
vi.mock('./CodexPersonalitySettings', () => ({ CodexPersonalitySettings: () => null }))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.preferences.mockResolvedValue(defaultAppPreferences)
  mocks.update.mockImplementation(async patch => ({ ...defaultAppPreferences, ...patch }))
  mocks.instructions.mockResolvedValue({ instructions: 'Saved instructions', configPath: null })
  mocks.saveInstructions.mockImplementation(async instructions => ({
    instructions,
    configPath: null,
  }))
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

test('loads custom instructions independently of pending preferences and keeps drafts across renders', async () => {
  const pending = deferred<typeof defaultAppPreferences>()
  mocks.preferences.mockReturnValue(pending.promise)
  const { rerender } = render(<ContextSettingsPage />)
  const editor = await screen.findByTestId('context-wework-instructions-textarea')
  expect(editor).toHaveValue('Saved instructions')
  expect(screen.getByTestId('context-terminal-injection-toggle')).toBeDisabled()
  fireEvent.change(editor, { target: { value: 'Unsaved draft' } })
  rerender(<ContextSettingsPage />)
  await act(async () => pending.resolve(defaultAppPreferences))
  expect(editor).toHaveValue('Unsaved draft')
  expect(mocks.preferences).toHaveBeenCalledTimes(1)
  expect(mocks.instructions).toHaveBeenCalledTimes(1)
})

test('makes preferences usable while instructions are pending', async () => {
  mocks.instructions.mockReturnValue(new Promise(() => {}))
  render(<ContextSettingsPage />)
  const toggle = screen.getByTestId('context-terminal-injection-toggle')
  await waitFor(() => expect(toggle).toBeEnabled())
  await userEvent.click(toggle)
  await waitFor(() =>
    expect(mocks.update).toHaveBeenCalledWith({
      terminalContextInjectionEnabled: !defaultAppPreferences.terminalContextInjectionEnabled,
    })
  )
  expect(screen.queryByTestId('context-wework-instructions-textarea')).not.toBeInTheDocument()
})

test('does not overwrite instruction edits made while an earlier save is pending', async () => {
  const pending = deferred<{ instructions: string; configPath: null }>()
  mocks.saveInstructions.mockReturnValue(pending.promise)
  render(<ContextSettingsPage />)
  const editor = await screen.findByTestId('context-wework-instructions-textarea')
  fireEvent.change(editor, { target: { value: 'Submitted draft' } })
  await userEvent.click(screen.getByTestId('context-wework-instructions-save-button'))
  expect(mocks.saveInstructions).toHaveBeenCalledWith('Submitted draft')
  fireEvent.change(editor, { target: { value: 'Newer draft' } })
  await act(async () => pending.resolve({ instructions: 'Normalized receipt', configPath: null }))
  expect(editor).toHaveValue('Newer draft')
  expect(screen.getByTestId('context-wework-instructions-save-button')).toBeEnabled()
})

test('preserves supervisor edits when another preference is saved', async () => {
  const preferences = {
    ...defaultAppPreferences,
    experimentalFeaturesEnabled: true,
    supervisorPrinciples: 'Saved principles',
  }
  mocks.preferences.mockResolvedValue(preferences)
  mocks.update.mockImplementation(async patch => ({ ...preferences, ...patch }))
  render(<ContextSettingsPage />)
  const editor = await screen.findByTestId('context-supervisor-principles-textarea')
  fireEvent.change(editor, { target: { value: 'Unsubmitted principles' } })
  await userEvent.click(screen.getByTestId('context-terminal-injection-toggle'))
  await waitFor(() => expect(screen.getByTestId('context-terminal-injection-toggle')).toBeEnabled())
  expect(editor).toHaveValue('Unsubmitted principles')
  expect(screen.getByTestId('context-supervisor-principles-save-button')).toBeEnabled()
})

test('rolls back a rejected optimistic toggle and leaves instructions usable', async () => {
  mocks.update.mockRejectedValue(new Error('Write failed'))
  render(<ContextSettingsPage />)
  const toggle = screen.getByTestId('context-terminal-injection-toggle')
  await waitFor(() => expect(toggle).toBeEnabled())
  await userEvent.click(toggle)
  await waitFor(() => expect(toggle).toBeEnabled())
  expect(toggle).toHaveAttribute(
    'aria-checked',
    String(defaultAppPreferences.terminalContextInjectionEnabled)
  )
  expect(screen.getByTestId('context-settings-status')).toHaveTextContent('上下文设置保存失败')
  expect(screen.getByTestId('context-wework-instructions-textarea')).toHaveValue(
    'Saved instructions'
  )
})

test('ignores an earlier mount read after reopening the page', async () => {
  const pending = deferred<{ instructions: string; configPath: null }>()
  mocks.instructions.mockReturnValueOnce(pending.promise)
  const first = render(<ContextSettingsPage />)
  await waitFor(() => expect(mocks.instructions).toHaveBeenCalledTimes(1))
  first.unmount()
  render(<ContextSettingsPage />)
  const editor = await screen.findByTestId('context-wework-instructions-textarea')
  await act(async () => pending.resolve({ instructions: 'Detached value', configPath: null }))
  expect(editor).toHaveValue('Saved instructions')
})

test('initializes and clamps the compaction threshold, then uses the saved receipt', async () => {
  mocks.preferences.mockResolvedValue({ ...defaultAppPreferences, contextCompactionThreshold: 73 })
  mocks.update.mockResolvedValue({ ...defaultAppPreferences, contextCompactionThreshold: 95 })
  render(<ContextSettingsPage />)
  const input = screen.getByTestId('context-compaction-threshold-input')
  await waitFor(() => expect(input).toHaveValue(73))
  fireEvent.change(input, { target: { value: '999' } })
  fireEvent.blur(input)
  await waitFor(() => expect(input).toHaveValue(95))
  expect(mocks.update).toHaveBeenCalledTimes(1)
  expect(mocks.update).toHaveBeenCalledWith({ contextCompactionThreshold: 100 })
})

test('shows a preference read failure without blocking saved instructions', async () => {
  mocks.preferences.mockRejectedValue(new Error('Unreadable preferences'))
  render(<ContextSettingsPage />)
  await waitFor(() =>
    expect(screen.getByTestId('context-settings-status')).toHaveTextContent('上下文设置加载失败')
  )
  expect(await screen.findByTestId('context-wework-instructions-textarea')).toHaveValue(
    'Saved instructions'
  )
})

test('accepts the canonical instruction receipt when the draft has not changed', async () => {
  mocks.saveInstructions.mockResolvedValue({
    instructions: 'Normalized instructions',
    configPath: null,
  })
  render(<ContextSettingsPage />)
  const editor = await screen.findByTestId('context-wework-instructions-textarea')
  fireEvent.change(editor, { target: { value: 'Submitted' } })
  await userEvent.click(screen.getByTestId('context-wework-instructions-save-button'))
  await waitFor(() => expect(editor).toHaveValue('Normalized instructions'))
  expect(screen.getByTestId('context-wework-instructions-save-button')).toBeDisabled()
})

test('keeps page drafts without rereading when the language changes', async () => {
  render(<ContextSettingsPage />)
  const editor = await screen.findByTestId('context-wework-instructions-textarea')
  fireEvent.change(editor, { target: { value: 'Unsaved instructions' } })
  const previousLanguage = i18n.language
  try {
    await act(async () => {
      await i18n.changeLanguage(previousLanguage.startsWith('en') ? 'zh-CN' : 'en')
    })
    expect(editor).toHaveValue('Unsaved instructions')
    expect(mocks.preferences).toHaveBeenCalledTimes(1)
    expect(mocks.instructions).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => {
      await i18n.changeLanguage(previousLanguage)
    })
  }
})
