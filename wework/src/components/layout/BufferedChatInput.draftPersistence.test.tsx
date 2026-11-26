import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createScopedDraftStore } from '@/features/workbench/scopedDraftStore'
import { ScopedDraftChatInput } from './BufferedChatInput'

vi.mock('@/components/chat/ChatInput', () => ({
  ChatInput({ onChange }: { onChange(value: string): void }) {
    return (
      <button type="button" onClick={() => onChange('unsent draft')}>
        Edit draft
      </button>
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

it('persists an edit before the buffered draft store update', () => {
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
  expect(draftStore.read('blank:0').value).toBe('')
  vi.advanceTimersByTime(250)
  expect(createScopedDraftStore({ storageScope }).read('blank:0').value).toBe('unsent draft')
})
