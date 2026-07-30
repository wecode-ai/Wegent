import { beforeEach, describe, expect, test, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
const listenMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

import { APPSHOT_CAPTURED_EVENT, subscribeToAppshots } from './appshots'

describe('appshots', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    listenMock.mockReset()
  })

  test('delivers pending native captures as existing attachments and acknowledges them', async () => {
    const unlistenCaptured = vi.fn()
    listenMock.mockResolvedValueOnce(unlistenCaptured)
    invokeMock.mockImplementation(command => {
      if (command === 'take_pending_appshots') {
        return Promise.resolve([
          {
            id: 'capture-1',
            filename: 'appshot.png',
            mimeType: 'image/png',
            fileSize: 2048,
            path: '/tmp/appshot.png',
            textAttachment: {
              filename: 'appshot-context.txt',
              fileSize: 128,
              path: '/tmp/appshot-context.txt',
              textLength: 128,
              textPreview: 'Visible and off-screen text',
            },
          },
        ])
      }
      return Promise.resolve()
    })
    const onAttachments = vi.fn()
    const dispose = await subscribeToAppshots(onAttachments)

    expect(listenMock).toHaveBeenCalledOnce()
    expect(listenMock).toHaveBeenCalledWith(APPSHOT_CAPTURED_EVENT, expect.any(Function))
    expect(invokeMock).not.toHaveBeenCalledWith('take_pending_appshots_permission')
    expect(onAttachments).toHaveBeenCalledWith([
      expect.objectContaining({
        filename: 'appshot.png',
        mime_type: 'image/png',
        local_path: '/tmp/appshot.png',
        ui_group_id: 'appshot-capture-1',
        ui_group_role: 'primary',
        ui_kind: 'appshot',
      }),
      expect.objectContaining({
        filename: 'appshot-context.txt',
        mime_type: 'text/plain',
        local_path: '/tmp/appshot-context.txt',
        text_preview: 'Visible and off-screen text',
        ui_group_id: 'appshot-capture-1',
        ui_group_role: 'companion',
        ui_kind: 'appshot',
      }),
    ])
    expect(invokeMock).toHaveBeenCalledWith('acknowledge_appshot', { id: 'capture-1' })

    dispose()
    expect(unlistenCaptured).toHaveBeenCalledOnce()
  })
})
