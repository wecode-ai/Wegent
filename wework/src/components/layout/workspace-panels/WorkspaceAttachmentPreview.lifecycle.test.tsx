import '@/i18n'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { saveBlobToDownloads } from '@/lib/blobDownload'
import type { WorkspaceAttachmentPreviewSource } from '@/types/workspace-files'
import { ImageEditProvider } from '@/components/chat/image-preview/ImageEditContext'
import { WorkspaceAttachmentPreview } from './WorkspaceAttachmentPreview'

vi.mock('@/lib/blobDownload', () => ({ saveBlobToDownloads: vi.fn() }))
vi.mock('./WorkspaceFilePreview', () => ({
  WorkspaceFilePreview: ({
    loading,
    error,
    binaryFile,
    onRetry,
  }: {
    loading: boolean
    error?: string | null
    binaryFile: { name: string } | null
    onRetry: () => void
  }) => (
    <div>
      <span data-testid="preview-state">{loading ? 'loading' : (error ?? binaryFile?.name)}</span>
      <button onClick={onRetry} data-testid="retry">
        Retry
      </button>
    </div>
  ),
}))
function pending<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { resolve, reject, promise }
}
function source(filename: string, loadFile: () => Promise<Blob>): WorkspaceAttachmentPreviewSource {
  return { filename, contentType: 'image/png', loadFile }
}

test('isolates a late attachment read from the new preview source', async () => {
  const old = pending<Blob>()
  const nextLoad = vi.fn(async () => new Blob(['new']))
  const { rerender } = render(
    <WorkspaceAttachmentPreview source={source('old.png', () => old.promise)} />
  )
  expect(screen.getByTestId('composer-attachment-preview-download')).toBeDisabled()
  rerender(<WorkspaceAttachmentPreview source={source('new.png', nextLoad)} />)
  await waitFor(() => expect(screen.getByTestId('preview-state')).toHaveTextContent('new.png'))
  await act(async () => old.resolve(new Blob(['old'])))
  expect(screen.getByTestId('preview-state')).toHaveTextContent('new.png')
  expect(nextLoad).toHaveBeenCalledOnce()
})

test('resolves the live image editor and retains saved preview state across Files remounts', async () => {
  const load = vi.fn(async () => new Blob(['image'], { type: 'image/png' }))
  const submit = vi.fn().mockResolvedValue(true)
  const comments = [{ x: 50, y: 50, text: 'Keep with the draft' }]
  const saveMarkup = vi.fn().mockResolvedValue({
    attachmentId: -2,
    file: new File(['marked'], 'marked.png', { type: 'image/png' }),
    comments,
  })
  const revoke = vi.fn()
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:panel-image')
      static revokeObjectURL = revoke
    }
  )
  const attachment = {
    ...source('image.png', load),
    image: {
      draftAttachmentId: -1,
      editorScope: 'nested-side-chat',
    },
  }
  let draftPresent = true
  const editor = {
    submit,
    saveMarkup,
    scope: 'nested-side-chat',
    hasDraftAttachment: () => draftPresent,
  }
  const panel = (actions: typeof editor | null = editor) => (
    <ImageEditProvider actions={actions}>
      <button type="button" data-testid="composer-action">
        Composer
      </button>
      <WorkspaceAttachmentPreview source={attachment} />
    </ImageEditProvider>
  )
  const view = render(panel())
  try {
    const viewer = await screen.findByTestId('attachment-image-side-viewer')
    expect(viewer).not.toHaveAttribute('aria-modal')
    expect(screen.getByTestId('composer-action').closest('[inert]')).toBeNull()
    fireEvent.click(screen.getByTestId('attachment-image-tool-background'))
    expect(submit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: 'image.png', mimeType: 'image/png' }),
      { kind: 'background' }
    )
    await waitFor(() =>
      expect(screen.getByTestId('attachment-image-tool-background')).toBeEnabled()
    )
    expect(screen.getByTestId('attachment-image-side-viewer')).toBe(viewer)
    fireEvent.click(screen.getByTestId('attachment-image-tool-markup'))
    fireEvent.click(screen.getByTestId('attachment-image-markup-comment'))
    fireEvent.click(screen.getByTestId('attachment-image-edit-surface'))
    fireEvent.change(screen.getByTestId('attachment-image-comment-input'), {
      target: { value: 'Keep with the draft' },
    })
    const save = screen.getByTestId('attachment-image-edit-save')
    save.focus()
    fireEvent.click(save)
    expect(await screen.findByRole('region', { name: 'marked.png' })).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId('composer-attachment-preview-panel')).toHaveFocus()
    )
    expect(saveMarkup).toHaveBeenCalledExactlyOnceWith(
      -1,
      expect.any(Function),
      expect.objectContaining({
        kind: 'markup',
        comments: [{ x: 50, y: 50, text: 'Keep with the draft' }],
      }),
      expect.any(AbortSignal)
    )
    expect(submit).toHaveBeenCalledOnce()
    const savedViewer = screen.getByTestId('attachment-image-side-viewer')
    fireEvent.click(screen.getByTestId('attachment-image-tool-comment'))
    expect(screen.getByTestId('attachment-image-comment-pin')).toHaveAttribute(
      'title',
      'Keep with the draft'
    )
    fireEvent.click(screen.getByTestId('attachment-image-edit-cancel'))
    draftPresent = false
    view.rerender(panel())
    await waitFor(() =>
      expect(screen.queryByTestId('attachment-image-tool-background')).not.toBeInTheDocument()
    )
    draftPresent = true
    view.rerender(panel())
    expect(await screen.findByTestId('attachment-image-tool-background')).toBeInTheDocument()
    expect(screen.getByTestId('attachment-image-side-viewer')).toBe(savedViewer)
    expect(load).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByTestId('attachment-image-tool-comment'))
    fireEvent.click(screen.getByTestId('attachment-image-edit-surface'))
    fireEvent.change(screen.getByTestId('attachment-image-comment-input'), {
      target: { value: 'Send this comment' },
    })
    fireEvent.click(screen.getByTestId('attachment-image-comment-save'))
    fireEvent.click(screen.getByTestId('attachment-image-edit-send'))
    expect(submit).toHaveBeenCalledTimes(2)
    draftPresent = false
    view.rerender(panel())
    await waitFor(() =>
      expect(screen.queryByTestId('attachment-image-tool-background')).not.toBeInTheDocument()
    )

    view.unmount()
    const remounted = render(panel())
    expect(await screen.findByRole('region', { name: 'marked.png' })).toBeInTheDocument()
    expect(screen.queryByTestId('attachment-image-tool-background')).not.toBeInTheDocument()
    expect(load).toHaveBeenCalledOnce()
    remounted.unmount()
    expect(revoke).toHaveBeenCalledTimes(3)
  } finally {
    vi.unstubAllGlobals()
  }
})

test('updates a remounted preview when an in-flight save completes', async () => {
  const load = vi.fn(async () => new Blob(['original'], { type: 'image/png' }))
  const lateSave = pending<{
    attachmentId: number
    file: File
    comments: Array<{ x: number; y: number; text: string }>
  }>()
  const submit = vi.fn().mockResolvedValue(true)
  const saveMarkup = vi.fn(() => lateSave.promise)
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:late-save')
      static revokeObjectURL = vi.fn()
    }
  )
  const attachment = {
    ...source('late.png', load),
    image: { draftAttachmentId: -1, editorScope: 'late-save' },
  }
  const panel = () => (
    <ImageEditProvider actions={{ submit, saveMarkup, scope: 'late-save' }}>
      <WorkspaceAttachmentPreview source={attachment} />
    </ImageEditProvider>
  )
  const first = render(panel())
  try {
    await screen.findByTestId('attachment-image-side-viewer')
    fireEvent.click(screen.getByTestId('attachment-image-tool-markup'))
    fireEvent.click(screen.getByTestId('attachment-image-markup-comment'))
    fireEvent.click(screen.getByTestId('attachment-image-edit-surface'), { detail: 0 })
    fireEvent.change(screen.getByTestId('attachment-image-comment-input'), {
      target: { value: 'Save late' },
    })
    fireEvent.click(screen.getByTestId('attachment-image-markup-comment'))
    fireEvent.click(screen.getByTestId('attachment-image-edit-save'))
    expect(saveMarkup).toHaveBeenCalledOnce()

    first.unmount()
    const second = render(panel())
    await screen.findByTestId('attachment-image-side-viewer')
    await act(async () =>
      lateSave.resolve({
        attachmentId: -2,
        file: new File(['saved late'], 'saved-late.png', { type: 'image/png' }),
        comments: [{ x: 25, y: 30, text: 'Late comment' }],
      })
    )
    expect(await screen.findByRole('region', { name: 'saved-late.png' })).toBeInTheDocument()
    second.unmount()
  } finally {
    vi.unstubAllGlobals()
  }
})

test('keeps download errors local to their preview and clears them on retry', async () => {
  const download = pending<string>()
  vi.mocked(saveBlobToDownloads).mockReturnValueOnce(download.promise)
  const load = vi.fn(async () => new Blob(['image']))
  const attachment = source('image.png', load)
  render(<WorkspaceAttachmentPreview source={attachment} />)
  await waitFor(() =>
    expect(screen.getByTestId('composer-attachment-preview-download')).toBeEnabled()
  )
  fireEvent.click(screen.getByTestId('composer-attachment-preview-download'))
  await act(async () => download.reject(new Error('Disk unavailable')))
  expect(screen.getByTestId('preview-state')).toHaveTextContent('Disk unavailable')
  fireEvent.click(screen.getByTestId('retry'))
  expect(screen.getByTestId('preview-state')).toHaveTextContent('loading')
  await waitFor(() => expect(screen.getByTestId('preview-state')).toHaveTextContent('image.png'))
  expect(load).toHaveBeenCalledTimes(2)
})

test('ignores a previous download failure after retrying the same source', async () => {
  const download = pending<string>()
  vi.mocked(saveBlobToDownloads).mockReturnValueOnce(download.promise)
  const attachment = source('image.png', async () => new Blob(['image']))
  render(<WorkspaceAttachmentPreview source={attachment} />)
  await waitFor(() =>
    expect(screen.getByTestId('composer-attachment-preview-download')).toBeEnabled()
  )
  fireEvent.click(screen.getByTestId('composer-attachment-preview-download'))
  fireEvent.click(screen.getByTestId('retry'))
  await waitFor(() =>
    expect(screen.getByTestId('composer-attachment-preview-download')).toBeEnabled()
  )
  await act(async () => download.reject(new Error('Old download failed')))
  expect(screen.getByTestId('preview-state')).toHaveTextContent('image.png')
  expect(screen.queryByText('Old download failed')).toBeNull()
})
