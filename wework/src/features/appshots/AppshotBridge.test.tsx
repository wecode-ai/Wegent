import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Attachment } from '@/types/api'
import { AppshotBridge } from './AppshotBridge'

const { addExistingAttachment, subscribeToAppshots } = vi.hoisted(() => ({
  addExistingAttachment: vi.fn(),
  subscribeToAppshots: vi.fn(),
}))

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({ projectChat: { addExistingAttachment } }),
}))

vi.mock('@/tauri/appshots', () => ({ subscribeToAppshots }))

describe('AppshotBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    subscribeToAppshots.mockResolvedValue(vi.fn())
  })

  test('opens Wework and adds the captured window to the current attachments', async () => {
    const onOpenWework = vi.fn()
    render(<AppshotBridge onOpenWework={onOpenWework} />)
    await waitFor(() => expect(subscribeToAppshots).toHaveBeenCalledOnce())

    const attachment: Attachment = {
      id: -1,
      filename: 'appshot.png',
      file_size: 2048,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-07-15T00:00:00.000Z',
      local_path: '/tmp/appshot.png',
      local_preview_url: '/tmp/appshot.png',
    }
    const onAttachments = subscribeToAppshots.mock.calls[0][0]
    onAttachments([attachment])

    expect(onOpenWework).toHaveBeenCalledOnce()
    expect(addExistingAttachment).toHaveBeenCalledWith(attachment)
  })
})
