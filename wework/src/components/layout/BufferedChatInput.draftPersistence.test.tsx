import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createScopedDraftStore } from '@/features/workbench/scopedDraftStore'
import { ScopedDraftChatInput } from './BufferedChatInput'

vi.mock('@/components/chat/ChatInput', () => ({
  ChatInput({
    onChange,
    onSubmit,
  }: {
    onChange(value: string): unknown
    onSubmit(value?: string): unknown
  }) {
    return (
      <>
        <button type="button" onClick={() => onChange('unsent draft')}>
          Edit draft
        </button>
        <button type="button" onClick={() => onSubmit()}>
          Submit draft
        </button>
      </>
    )
  },
}))

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  localStorage.clear()
})

it('records an edit before its debounced persistence', () => {
  const storageScope = 'account:one:tab:main'
  const draftStore = createScopedDraftStore({ storageScope })
  const onDraftEdit = vi.fn()

  render(
    <ScopedDraftChatInput
      draftStore={draftStore}
      draftScope="blank:0"
      writeDraft={draftStore.write}
      onDraftEdit={onDraftEdit}
      onSubmit={vi.fn()}
      disabled={false}
    />
  )

  fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }))

  expect(onDraftEdit).toHaveBeenCalledWith('unsent draft')
  expect(draftStore.read('blank:0').value).toBe('unsent draft')
  expect(createScopedDraftStore({ storageScope }).read('blank:0').value).toBe('')
  vi.advanceTimersByTime(250)
  expect(createScopedDraftStore({ storageScope }).read('blank:0').value).toBe('unsent draft')
})

it('clears an edited draft when it is submitted before the persistence delay', () => {
  const storageScope = 'account:one:tab:main'
  const draftStore = createScopedDraftStore({ storageScope })
  const onSubmit = vi.fn()

  render(
    <ScopedDraftChatInput
      draftStore={draftStore}
      draftScope="blank:0"
      writeDraft={draftStore.write}
      onSubmit={onSubmit}
      disabled={false}
    />
  )

  fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }))
  fireEvent.click(screen.getByRole('button', { name: 'Submit draft' }))

  expect(onSubmit).toHaveBeenCalledWith('unsent draft')
  expect(draftStore.read('blank:0').value).toBe('')
  vi.advanceTimersByTime(250)
  expect(createScopedDraftStore({ storageScope }).exportInputs()).toEqual({})
})
