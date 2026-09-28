import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import type { Attachment } from '@/types/api'
import { readElectronLocalFile } from '@/lib/electron-local-file'
import { openLocalFileInWorkspaceApp } from '@/lib/local-terminal'
import { AttachmentDownloadProvider } from '../AttachmentDownloadProvider'
import { AttachmentBadges } from './AttachmentBadges'
import { AttachmentPreviewContext } from '../AttachmentPreviewContext'
import type { WorkspaceAttachmentPreviewSource } from '@/types/workspace-files'

vi.mock('@/lib/electron-local-file', () => ({ readElectronLocalFile: vi.fn() }))
vi.mock('@/lib/local-terminal', () => ({ openLocalFileInWorkspaceApp: vi.fn() }))

const attachment: Attachment = {
  id: 42,
  filename: 'test-document.md',
  mime_type: 'text/markdown',
  file_size: 20,
  status: 'ready',
  file_extension: '.md',
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

test.each(['/tmp/test-document.md', 'C:\\test\\test-document.md'])(
  'opens a local file card from %s without fetching a cloud attachment',
  async localPath => {
    const { fetchBlob, remove } = renderAttachment({ local_path: localPath })
    expect(readElectronLocalFile).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('attachment-document-preview-button'))
    expect(openLocalFileInWorkspaceApp).toHaveBeenCalledExactlyOnceWith(
      localPath,
      '/test/workspace'
    )
    expect(readElectronLocalFile).not.toHaveBeenCalled()
    expect(fetchBlob).not.toHaveBeenCalled()

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('attachment-badge')).toBeInTheDocument()
    expect(remove).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('remove-attachment-button'))
    expect(remove).toHaveBeenCalledExactlyOnceWith(42)
    expect(openLocalFileInWorkspaceApp).toHaveBeenCalledTimes(1)
  }
)

test('opens a cloud attachment in the bound side panel using the keyboard', async () => {
  const { fetchBlob, openPreview } = renderAttachment()
  screen.getByTestId('attachment-document-preview-button').focus()
  await userEvent.keyboard('{Enter}')
  expect(openPreview).toHaveBeenCalledTimes(1)
  const source = openPreview.mock.calls[0][0]
  expect(source.filename).toBe('test-document.md')
  expect(await (await source.loadFile()).text()).toBe('# test cloud content')
  expect(fetchBlob).toHaveBeenCalledExactlyOnceWith(42)
  expect(readElectronLocalFile).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

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

test.each([undefined, '/tmp/test-document.pdf'])(
  'routes PDF %s to the side panel with the correct file reader',
  async localPath => {
    vi.mocked(readElectronLocalFile).mockResolvedValue(new TextEncoder().encode('%PDF-1.4'))
    const { openPreview, fetchBlob } = renderAttachment({
      filename: 'test-document.pdf',
      mime_type: 'application/pdf',
      file_extension: '.pdf',
      local_path: localPath,
    })
    await userEvent.click(screen.getByTestId('attachment-document-preview-button'))
    const source = openPreview.mock.calls[0][0]
    await source.loadFile()
    if (localPath) {
      expect(readElectronLocalFile).toHaveBeenCalledExactlyOnceWith(localPath)
      expect(fetchBlob).not.toHaveBeenCalled()
    } else expect(fetchBlob).toHaveBeenCalledExactlyOnceWith(42)
    expect(openLocalFileInWorkspaceApp).not.toHaveBeenCalled()
  }
)

test.each([
  [4999, false],
  [5000, true],
  [25000, true],
  [25001, false],
])('gates restoration for %i pasted characters', async (count, canRestore) => {
  const { openPreview, restore, remove } = renderAttachment({
    filename: 'test-paste.txt',
    ui_kind: 'pasted-text',
    text_content: 'x'.repeat(Number(count)),
    text_length: Number(count),
  })
  expect(Boolean(screen.queryByTestId('show-text-attachment-button'))).toBe(canRestore)
  await userEvent.click(screen.getByTestId('attachment-text-open-button'))
  expect(openPreview).toHaveBeenCalledTimes(1)
  expect(remove).not.toHaveBeenCalled()
  if (canRestore) {
    await userEvent.click(screen.getByTestId('show-text-attachment-button'))
    expect(restore).toHaveBeenCalledTimes(1)
    expect(openPreview).toHaveBeenCalledTimes(1)
  }
})
