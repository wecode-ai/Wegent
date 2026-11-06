import type { ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { Attachment } from '@/types/api'
import type { WorkspaceAttachmentPreviewSource } from '@/types/workspace-files'
import { readElectronLocalFile } from '@/lib/electron-local-file'
import { AttachmentDownloadProvider } from './AttachmentDownloadProvider'
import { AttachmentPreviewContext } from './AttachmentPreviewContext'
import { WorkspaceFileReaderProvider } from './WorkspaceFileReaderProvider'
import { useAttachmentPreview } from './useAttachmentPreview'

vi.mock('@/lib/electron-local-file', () => ({ readElectronLocalFile: vi.fn() }))

const attachment: Attachment = {
  id: 42,
  filename: 'clipboard-text.txt',
  file_extension: '.txt',
  mime_type: 'text/plain',
  file_size: 150000,
  status: 'ready',
  created_at: '2026-11-06T00:00:00Z',
  text_preview: 'truncated preview',
}

describe('attachment preview sources', () => {
  test('exposes no preview action outside a workbench preview scope', () => {
    expect(renderHook(useAttachmentPreview).result.current).toBeNull()
  })

  test.each([undefined, '/tmp/clipboard-text.txt', 'C:\\attachments\\clipboard-text.txt'])(
    'loads complete text from the correct source for %s and propagates read errors for retry',
    async localPath => {
      const content = '完整内容\n'.repeat(30000)
      const blob = new Blob([content], { type: 'text/plain' })
      const fetchBlob = vi.fn().mockResolvedValue(blob)
      const localRead = vi.mocked(readElectronLocalFile).mockReset()
      localRead.mockResolvedValue(new TextEncoder().encode(content))
      const open = vi.fn<(source: WorkspaceAttachmentPreviewSource) => void>()
      const wrapper = ({ children }: { children: ReactNode }) => (
        <AttachmentDownloadProvider fetchAttachmentBlob={fetchBlob}>
          <AttachmentPreviewContext.Provider value={open}>
            {children}
          </AttachmentPreviewContext.Provider>
        </AttachmentDownloadProvider>
      )
      const { result } = renderHook(useAttachmentPreview, { wrapper })
      act(() => result.current!({ ...attachment, local_path: localPath }))
      const source = open.mock.calls[0][0]
      expect(source.filename).toBe(attachment.filename)
      expect(await (await source.loadFile()).text()).toBe(content)
      if (localPath) {
        expect(localRead).toHaveBeenCalledExactlyOnceWith(localPath)
        expect(fetchBlob).not.toHaveBeenCalled()
        localRead.mockRejectedValueOnce(new Error('read failed'))
      } else {
        expect(fetchBlob).toHaveBeenCalledExactlyOnceWith(42)
        expect(localRead).not.toHaveBeenCalled()
        fetchBlob.mockRejectedValueOnce(new Error('read failed'))
      }
      await expect(source.loadFile()).rejects.toThrow('read failed')
      expect(await (await source.loadFile()).text()).toBe(content)
    }
  )

  test('reads remote workspace attachments from their owning device instead of a local path', async () => {
    const content = 'remote complete content'
    const read = vi.fn().mockResolvedValue({
      offset: 0,
      size: content.length,
      contentBase64: btoa(content),
      eof: true,
    })
    const open = vi.fn<(source: WorkspaceAttachmentPreviewSource) => void>()
    const wrapper = ({ children }: { children: ReactNode }) => (
      <WorkspaceFileReaderProvider readWorkspaceFileChunk={read}>
        <AttachmentPreviewContext.Provider value={open}>
          {children}
        </AttachmentPreviewContext.Provider>
      </WorkspaceFileReaderProvider>
    )
    const { result } = renderHook(useAttachmentPreview, { wrapper })
    act(() =>
      result.current!({
        ...attachment,
        local_path: '/unrelated/local.txt',
        workspace_file: { device_id: 'remote', workspace_path: '/workspace', path: 'context.txt' },
      })
    )
    expect(await (await open.mock.calls[0][0].loadFile()).text()).toBe(content)
    expect(read).toHaveBeenCalledExactlyOnceWith(
      'remote',
      '/workspace/context.txt',
      0,
      '/workspace'
    )
  })
})
