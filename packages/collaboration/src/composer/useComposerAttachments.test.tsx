// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { Attachment } from '@wegent/chat-core/runtime'
import { useComposerAttachments } from './useComposerAttachments'

const attachment: Attachment = {
  id: 1,
  filename: 'notes.txt',
  file_size: 5,
  mime_type: 'text/plain',
  status: 'ready',
  file_extension: '.txt',
  created_at: '2026-09-23T00:00:00Z',
}

describe('useComposerAttachments', () => {
  it('keeps an untouched scope stable across renders and updates to other scopes', () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const root = createRoot(document.createElement('div'))
    let current!: ReturnType<typeof useComposerAttachments>
    const uploadAttachment = vi.fn(async () => attachment)
    const deleteAttachment = vi.fn(async () => {})

    function Harness({ scopeKey }: { scopeKey: string }) {
      current = useComposerAttachments({
        scopeKey,
        uploadAttachment,
        deleteAttachment,
      })
      return null
    }

    const renderScope = (scopeKey: string) => {
      act(() => root.render(<Harness scopeKey={scopeKey} />))
    }

    try {
      renderScope('first')
      const firstState = current.state
      expect(current.stateByScope).toEqual({})

      renderScope('first')
      expect(current.state).toBe(firstState)
      expect(current.attachments).toBe(firstState.attachments)
      expect(current.uploadingFiles).toBe(firstState.uploadingFiles)
      expect(current.errors).toBe(firstState.errors)

      act(() => current.addExistingAttachmentForScope('other', attachment))
      expect(current.state).toBe(firstState)
      expect(current.stateByScope.other.attachments).toEqual([attachment])

      renderScope('second')
      expect(current.state).not.toBe(firstState)
      expect(current.attachments).not.toBe(firstState.attachments)
      expect(current.uploadingFiles).not.toBe(firstState.uploadingFiles)
      expect(current.errors).not.toBe(firstState.errors)
      expect(current.stateByScope.second).toBeUndefined()
    } finally {
      act(() => root.unmount())
    }
  })
})
