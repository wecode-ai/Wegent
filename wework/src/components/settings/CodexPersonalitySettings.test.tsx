import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import type { CodexPersonality } from '@/features/model-settings/localCodexSettings'
import { CodexPersonalitySettings } from './CodexPersonalitySettings'

const mocks = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }))
vi.mock('@/features/model-settings/localCodexSettings', () => ({
  DEFAULT_CODEX_PERSONALITY: 'pragmatic',
  getLocalCodexPersonality: mocks.read,
  saveLocalCodexPersonality: mocks.save,
}))
function held<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.read.mockResolvedValue('pragmatic')
  mocks.save.mockResolvedValue('friendly')
})

async function openMenu() {
  const select = await screen.findByTestId('codex-personality-select')
  await waitFor(() => expect(select).toBeEnabled())
  await userEvent.click(select)
  return select
}

test('waits for the read and displays the persisted value', async () => {
  const pending = held<CodexPersonality>()
  mocks.read.mockReturnValue(pending.promise)
  render(<CodexPersonalitySettings />)
  expect(screen.getByTestId('codex-personality-select')).toBeDisabled()
  await act(async () => {
    pending.resolve('friendly')
    await pending.promise
  })
  await userEvent.click(screen.getByTestId('codex-personality-select'))
  expect(screen.getByTestId('codex-personality-option-friendly')).toHaveAttribute(
    'aria-selected',
    'true'
  )
  expect(mocks.save).not.toHaveBeenCalled()
})

test('keeps inside clicks open and closes only on an outside mouse press', async () => {
  render(<CodexPersonalitySettings />)
  const select = await openMenu()
  fireEvent.mouseDown(screen.getByRole('listbox'))
  expect(select).toHaveAttribute('aria-expanded', 'true')
  fireEvent.mouseDown(document.body)
  expect(select).toHaveAttribute('aria-expanded', 'false')
})

test('shows a pending selection, submits once, and uses the persisted receipt', async () => {
  const pending = held<CodexPersonality>()
  mocks.save.mockReturnValue(pending.promise)
  render(<CodexPersonalitySettings />)
  const select = await openMenu()
  const option = screen.getByTestId('codex-personality-option-friendly')
  act(() => {
    fireEvent.click(option)
    fireEvent.click(option)
  })
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith('friendly')
  expect(select).toBeDisabled()
  expect(select).toHaveAttribute('aria-expanded', 'false')
  await act(async () => {
    pending.resolve('pragmatic')
    await pending.promise
  })
  expect(select).toBeEnabled()
  await userEvent.click(select)
  expect(screen.getByTestId('codex-personality-option-pragmatic')).toHaveAttribute(
    'aria-selected',
    'true'
  )
})

test('failed saves restore the last committed personality and allow another selection', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    mocks.save.mockRejectedValueOnce(new Error('write denied'))
    render(<CodexPersonalitySettings />)
    const select = await openMenu()
    await userEvent.click(screen.getByTestId('codex-personality-option-friendly'))
    await userEvent.click(select)
    expect(screen.getByTestId('codex-personality-option-pragmatic')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await userEvent.click(screen.getByTestId('codex-personality-option-friendly'))
    await userEvent.click(select)
    expect(screen.getByTestId('codex-personality-option-friendly')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(mocks.save).toHaveBeenCalledTimes(2)
  } finally {
    log.mockRestore()
  }
})

test('old read and write receipts cannot affect a newly mounted selector', async () => {
  const oldRead = held<CodexPersonality>()
  mocks.read.mockReturnValueOnce(oldRead.promise)
  const view = render(<CodexPersonalitySettings />)
  view.unmount()
  const current = render(<CodexPersonalitySettings />)
  const select = await openMenu()
  await act(async () => {
    oldRead.resolve('friendly')
    await oldRead.promise
  })
  expect(screen.getByTestId('codex-personality-option-pragmatic')).toHaveAttribute(
    'aria-selected',
    'true'
  )
  const write = held<CodexPersonality>()
  mocks.save.mockReturnValueOnce(write.promise)
  await userEvent.click(screen.getByTestId('codex-personality-option-friendly'))
  expect(select).toBeDisabled()
  current.unmount()
  render(<CodexPersonalitySettings />)
  await openMenu()
  await act(async () => {
    write.resolve('friendly')
    await write.promise
  })
  expect(screen.getByTestId('codex-personality-option-pragmatic')).toHaveAttribute(
    'aria-selected',
    'true'
  )
})
