import { readElectronLocalFile } from '@/lib/electron-local-file'
import { openLocalFileInWorkspaceApp } from '@/lib/local-terminal'
import type { Attachment } from '@/types/api'
import type { WorkspaceAttachmentPreviewSource } from '@/types/workspace-files'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import { AttachmentDownloadProvider } from '../AttachmentDownloadProvider'
import { AttachmentPreviewContext } from '../AttachmentPreviewContext'
import { AttachmentBadges } from './AttachmentBadges'

vi.mock('@/lib/electron-local-file', () => ({ readElectronLocalFile: vi.fn() }))
vi.mock('@/lib/local-terminal', () => ({ openLocalFileInWorkspaceApp: vi.fn() }))

const attachment: Attachment = {
  id: 42,
  filename: 'test-document.zip',
  mime_type: 'application/zip',
  file_size: 20,
  status: 'ready',
  file_extension: '.zip',
  created_at: '2026-09-19T00:00:00Z',
}

beforeEach(() => {
  vi.mocked(readElectronLocalFile).mockReset()
  vi.mocked(openLocalFileInWorkspaceApp).mockReset().mockResolvedValue(undefined)
})

function renderAttachment(overrides: Partial<Attachment> = {}) {
  const fetchBlob = vi.fn().mockResolvedValue(new Blob(['# test cloud content']))
  const remove = vi.fn()
  const openPreview = vi.fn<(source: WorkspaceAttachmentPreviewSource) => void>()
  const restore = vi.fn()
  render(
    <AttachmentDownloadProvider fetchAttachmentBlob={fetchBlob}>
      <AttachmentPreviewContext.Provider value={openPreview}>
        <AttachmentBadges
          workspacePath="/test/workspace"
          attachments={[{ ...attachment, ...overrides }]}
          uploadingFiles={new Map()}
          errors={new Map()}
          onRemoveAttachment={remove}
          onShowTextAttachment={restore}
        />
      </AttachmentPreviewContext.Provider>
    </AttachmentDownloadProvider>
  )
  return { fetchBlob, remove, openPreview, restore }
}

test('opens a cloud attachment in the bound side panel using the keyboard', async () => {
  const { fetchBlob, openPreview } = renderAttachment()
  screen.getByTestId('attachment-document-preview-button').focus()
  await userEvent.keyboard('{Enter}')
  expect(openPreview).toHaveBeenCalledTimes(1)
  const source = openPreview.mock.calls[0][0]
  expect(source.filename).toBe('test-document.zip')
  expect(await (await source.loadFile()).text()).toBe('# test cloud content')
  expect(fetchBlob).toHaveBeenCalledExactlyOnceWith(42)
  expect(readElectronLocalFile).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test.each(['/tmp/pasted.txt', 'C:\\attachments\\pasted.txt'])(
  'previews a local pasted text attachment at %s without launching an external app',
  async localPath => {
    const content = '完整文本\n'.repeat(6000)
    vi.mocked(readElectronLocalFile).mockResolvedValue(new TextEncoder().encode(content))
    const { openPreview, fetchBlob, remove, restore } = renderAttachment({
      filename: 'pasted.txt',
      file_extension: '.txt',
      mime_type: 'text/plain',
      ui_kind: 'pasted-text',
      text_content: content,
      text_length: content.length,
      local_path: localPath,
    })
    await userEvent.click(screen.getByTestId('attachment-text-open-button'))
    expect(await (await openPreview.mock.calls[0][0].loadFile()).text()).toBe(content)
    expect(openLocalFileInWorkspaceApp).not.toHaveBeenCalled()
    expect(fetchBlob).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
  }
)

test('shows native opening failures and permits retry without switching to an inline preview', async () => {
  vi.mocked(openLocalFileInWorkspaceApp)
    .mockRejectedValueOnce(new Error('test open failure'))
    .mockResolvedValueOnce(undefined)
  const { fetchBlob } = renderAttachment({ local_path: '/tmp/test-document.md' })
  await userEvent.click(screen.getByTestId('attachment-document-preview-button'))
  expect(await screen.findByText('test open failure')).toBeInTheDocument()
  await userEvent.click(screen.getByTestId('attachment-document-preview-button'))
  await waitFor(() =>
    expect(screen.queryByTestId('attachment-error-badge')).not.toBeInTheDocument()
  )
  expect(openLocalFileInWorkspaceApp).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(fetchBlob).not.toHaveBeenCalled()
})

test('dismisses a native opening error while keeping the attachment available', async () => {
  vi.mocked(openLocalFileInWorkspaceApp).mockRejectedValueOnce(new Error('test open failure'))
  const { remove } = renderAttachment({ local_path: '/tmp/test-document.md' })
  await userEvent.click(screen.getByTestId('attachment-document-preview-button'))
  expect(await screen.findByTestId('attachment-error-badge')).toBeInTheDocument()

  await userEvent.click(screen.getByTestId('dismiss-attachment-error-button'))

  expect(screen.queryByTestId('attachment-error-badge')).not.toBeInTheDocument()
  expect(screen.getByTestId('attachment-badge')).toBeInTheDocument()
  expect(remove).not.toHaveBeenCalled()
})

test('clears a native opening error when its attachment is removed', async () => {
  vi.mocked(openLocalFileInWorkspaceApp).mockRejectedValueOnce(new Error('test open failure'))
  const { remove } = renderAttachment({ local_path: '/tmp/test-document.md' })
  await userEvent.click(screen.getByTestId('attachment-document-preview-button'))
  expect(await screen.findByTestId('attachment-error-badge')).toBeInTheDocument()

  await userEvent.click(screen.getByTestId('remove-attachment-button'))

  expect(screen.queryByTestId('attachment-error-badge')).not.toBeInTheDocument()
  expect(remove).toHaveBeenCalledExactlyOnceWith(42)
})
