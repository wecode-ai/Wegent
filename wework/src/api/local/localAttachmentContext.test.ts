// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { readDroppedFiles } from '@/desktop/droppedFiles'
import { saveBlobToDownloads } from '@/lib/blobDownload'
import { createLocalDeliveryApi } from './localDelivery'

vi.mock('@/desktop/droppedFiles', () => ({ readDroppedFiles: vi.fn() }))
vi.mock('@/lib/blobDownload', () => ({ saveBlobToDownloads: vi.fn() }))

describe('local Issue attachment context', () => {
  beforeEach(() => vi.clearAllMocks())

  test('passes the exact project and Issue to every attachment operation', async () => {
    const file = new File(['demo'], 'kanban.html', { type: 'text/html' })
    vi.mocked(readDroppedFiles).mockResolvedValue([file])
    const request = vi.fn().mockResolvedValue({ path: '/demo/kanban.html' })
    const api = createLocalDeliveryApi(request)
    const context = { projectId: 'project-1', issueId: 'DEMO-1' }
    const scope = { project_id: 'project-1', item_id: 'DEMO-1', attachment_id: 'attachment-1' }

    await api.accessLoopItemAttachment('attachment-1', context)
    await expect(api.readLoopItemAttachment('attachment-1', context)).resolves.toBe(file)
    await api.downloadLoopItemAttachment('attachment-1', 'kanban.html', context)
    await api.deleteLoopItemAttachment('attachment-1', context)

    expect(request.mock.calls).toEqual([
      ['attachments.access', scope],
      ['attachments.access', scope],
      ['attachments.access', scope],
      ['attachments.delete', scope],
    ])
    expect(readDroppedFiles).toHaveBeenCalledWith(['/demo/kanban.html'])
    expect(saveBlobToDownloads).toHaveBeenCalledWith(file, 'kanban.html')
  })

  test('rejects missing ownership context without guessing or sending unscoped IPC', async () => {
    const request = vi.fn()
    const api = createLocalDeliveryApi(request)

    await expect(api.accessLoopItemAttachment('attachment-1')).rejects.toThrow(
      'project and Issue context'
    )
    await expect(api.readLoopItemAttachment('attachment-1')).rejects.toThrow(
      'project and Issue context'
    )
    await expect(api.downloadLoopItemAttachment('attachment-1', 'kanban.html')).rejects.toThrow(
      'project and Issue context'
    )
    await expect(
      api.deleteLoopItemAttachment('attachment-1', { projectId: ' ', issueId: 'DEMO-1' })
    ).rejects.toThrow('project and Issue context')
    expect(request).not.toHaveBeenCalled()
    expect(readDroppedFiles).not.toHaveBeenCalled()
    expect(saveBlobToDownloads).not.toHaveBeenCalled()
  })

  test('preserves executor rejection instead of probing other projects', async () => {
    const request = vi.fn().mockRejectedValue(new Error('Attachment does not belong to this Issue'))
    const api = createLocalDeliveryApi(request)

    await expect(
      api.readLoopItemAttachment('attachment-1', { projectId: 'project-2', issueId: 'DEMO-2' })
    ).rejects.toThrow('does not belong')
    expect(request).toHaveBeenCalledExactlyOnceWith('attachments.access', {
      project_id: 'project-2',
      item_id: 'DEMO-2',
      attachment_id: 'attachment-1',
    })
    expect(readDroppedFiles).not.toHaveBeenCalled()
  })
})
