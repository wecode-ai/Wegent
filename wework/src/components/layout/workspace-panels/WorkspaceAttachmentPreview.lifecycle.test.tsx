import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { saveBlobToDownloads } from '@/lib/blobDownload'
import type { WorkspaceAttachmentPreviewSource } from '@/types/workspace-files'
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
