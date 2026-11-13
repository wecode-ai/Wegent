// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { Attachment } from '@wegent/chat-core/runtime'
import { useComposerAttachments } from './useComposerAttachments'

function mountAttachments(uploadAttachment: (file: File) => Promise<Attachment>) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(document.createElement('div'))
  const deleteAttachment = vi.fn(async () => {})
  let current!: ReturnType<typeof useComposerAttachments>
  function Harness({ scopeKey }: { scopeKey: string }) {
    current = useComposerAttachments({ scopeKey, uploadAttachment, deleteAttachment })
    return null
  }
  const render = (scopeKey = 'record') => act(() => root.render(<Harness scopeKey={scopeKey} />))
  render()
  return {
    get current() {
      return current
    },
    deleteAttachment,
    render,
    dispose: () => act(() => root.unmount()),
  }
}
const binaryFile = () =>
  new File(['private work'], 'same.bin', { type: 'application/octet-stream' })

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
  it('discards an untracked upload that completes after its scope was reset', async () => {
    let finish!: (value: Attachment) => void
    const driver = mountAttachments(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    let pending!: Promise<void>
    try {
      act(() => {
        pending = driver.current.handleFileSelect(binaryFile())
      })
      act(() => driver.current.resetAttachments())
      await act(async () => {
        finish(attachment)
        await pending
      })
      expect(driver.current.attachments).toEqual([])
      expect(driver.current.isUploading).toBe(false)
      expect(driver.deleteAttachment).toHaveBeenCalledExactlyOnceWith(attachment.id)
    } finally {
      driver.dispose()
    }
  })

  it('restores the exact source File of a ready attachment without uploading it again', async () => {
    const upload = vi.fn(async () => attachment)
    const driver = mountAttachments(upload)
    const file = binaryFile()
    try {
      act(() => driver.current.addExistingSourceAttachment(attachment, file))
      expect(driver.current.getSourceFile(attachment.id)).toBe(file)
      expect(driver.current.getSelectedAttachments([file])).toEqual([attachment])
      await act(async () => driver.current.removeSourceFile(file))
      expect(driver.current.attachments).toEqual([])
      expect(driver.deleteAttachment).toHaveBeenCalledExactlyOnceWith(attachment.id)
      expect(upload).not.toHaveBeenCalled()
    } finally {
      driver.dispose()
    }
  })

  it('blocks submission while a selected import remains queued after its sibling is cancelled', async () => {
    let finishFirst!: (value: Attachment) => void
    let finishSecond!: (value: Attachment) => void
    const first = binaryFile()
    const second = binaryFile()
    const driver = mountAttachments(
      file =>
        new Promise(resolve => {
          if (file === first) finishFirst = resolve
          else finishSecond = resolve
        })
    )
    let pending!: Promise<void>
    try {
      act(() => {
        pending = driver.current.handleTrackedFileSelect([first, second])
      })
      await act(async () => driver.current.removeSourceFile(first))
      expect(driver.current.isAttachmentReadyToSend).toBe(false)
      await act(async () => {
        finishFirst(attachment)
      })
      expect(driver.current.isAttachmentReadyToSend).toBe(false)
      await act(async () => {
        finishSecond({ ...attachment, id: 2 })
        await pending
      })
      expect(driver.current.isAttachmentReadyToSend).toBe(true)
      expect(driver.current.getSelectedAttachments([second]).map(item => item.id)).toEqual([2])
    } finally {
      driver.dispose()
    }
  })
  it('removes one imported File while retaining an independently selected same-name file', async () => {
    const first = binaryFile()
    const second = binaryFile()
    const upload = vi.fn(async (file: File) => ({ ...attachment, id: file === first ? 1 : 2 }))
    const driver = mountAttachments(upload)
    try {
      await act(async () => driver.current.handleTrackedFileSelect(first))
      await act(async () => driver.current.handleFileSelect(second))
      expect(driver.current.getSelectedAttachments([]).map(item => item.id)).toEqual([2])
      await act(async () => driver.current.removeSourceFile(first))
      expect(driver.current.attachments.map(item => item.id)).toEqual([2])
      expect(driver.deleteAttachment).toHaveBeenCalledExactlyOnceWith(1)
    } finally {
      driver.dispose()
    }
  })

  it('cancels an imported upload before completion without adding an attachment or error later', async () => {
    let resolve!: (value: Attachment) => void
    const driver = mountAttachments(
      () =>
        new Promise(done => {
          resolve = done
        })
    )
    const file = binaryFile()
    let pending!: Promise<void>
    try {
      act(() => {
        pending = driver.current.handleTrackedFileSelect(file)
      })
      expect(driver.current.isUploading).toBe(true)
      await act(async () => driver.current.removeSourceFile(file))
      expect(driver.current.isUploading).toBe(false)
      expect(driver.current.isAttachmentReadyToSend).toBe(true)
      await act(async () => {
        resolve(attachment)
        await pending
      })
      expect(driver.current.attachments).toEqual([])
      expect(driver.current.errors.size).toBe(0)
      expect(driver.deleteAttachment).toHaveBeenCalledExactlyOnceWith(1)
    } finally {
      driver.dispose()
    }
  })

  it('does not start a removed queued import after the previous upload completes', async () => {
    let resolve!: (value: Attachment) => void
    const upload = vi.fn(
      () =>
        new Promise<Attachment>(done => {
          resolve = done
        })
    )
    const driver = mountAttachments(upload)
    const first = binaryFile()
    const removed = binaryFile()
    let pending!: Promise<void>
    try {
      act(() => {
        pending = driver.current.handleTrackedFileSelect([first, removed])
      })
      await act(async () => driver.current.removeSourceFile(removed))
      await act(async () => {
        resolve(attachment)
        await pending
      })
      expect(upload).toHaveBeenCalledExactlyOnceWith(first, expect.any(Function))
      expect(driver.current.attachments).toHaveLength(1)
      expect(driver.deleteAttachment).not.toHaveBeenCalled()
    } finally {
      driver.dispose()
    }
  })

  it('clears only an imported failure and allows reselecting that exact File', async () => {
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error('Import failed'))
      .mockResolvedValueOnce(attachment)
    const driver = mountAttachments(upload)
    const file = binaryFile()
    try {
      await act(async () => driver.current.handleTrackedFileSelect(file))
      expect(driver.current.errors.get(file.name)).toBe('Import failed')
      await act(async () => driver.current.removeSourceFile(file))
      expect(driver.current.errors.size).toBe(0)
      await act(async () => driver.current.handleTrackedFileSelect(file))
      expect(driver.current.getSelectedAttachments([file])).toHaveLength(1)
    } finally {
      driver.dispose()
    }
  })

  it('does not clear a newer same-name Task upload error when removing an import', async () => {
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error('Import failed'))
      .mockRejectedValueOnce(new Error('Task failed'))
    const driver = mountAttachments(upload)
    const imported = binaryFile()
    try {
      await act(async () => driver.current.handleTrackedFileSelect(imported))
      await act(async () => driver.current.handleFileSelect(binaryFile()))
      await act(async () => driver.current.removeSourceFile(imported))
      expect(driver.current.errors.get(imported.name)).toBe('Task failed')
    } finally {
      driver.dispose()
    }
  })

  it('keeps imported files scoped to their composer', async () => {
    const driver = mountAttachments(async () => attachment)
    const file = binaryFile()
    try {
      await act(async () => driver.current.handleTrackedFileSelect(file))
      driver.render('other')
      await act(async () => driver.current.removeSourceFile(file))
      expect(driver.deleteAttachment).not.toHaveBeenCalled()
      driver.render('record')
      expect(driver.current.getSelectedAttachments([file])).toHaveLength(1)
      await act(async () => driver.current.removeSourceFile(file))
      expect(driver.deleteAttachment).toHaveBeenCalledExactlyOnceWith(1)
    } finally {
      driver.dispose()
    }
  })
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
