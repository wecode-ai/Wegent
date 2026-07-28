import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createFeedbackApi } from './feedback'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

describe('createFeedbackApi', () => {
  beforeEach(() => invokeMock.mockReset())

  test('submits the exported bundle through the native command', async () => {
    invokeMock.mockResolvedValue({ report_id: 'WF-1', item_id: 'FEEDBACK-1' })
    const api = createFeedbackApi('https://wegent.example.com/api', () => 'token')

    await api.submit({
      reportId: 'WF-1',
      title: 'Problem',
      description: 'Details',
      context: { taskId: 'task-1' },
      bundlePath: '/tmp/wework-feedback-WF-1.zip',
    })

    expect(invokeMock).toHaveBeenCalledWith('submit_feedback_bundle', {
      request: {
        apiUrl: 'https://wegent.example.com/api/v1/feedback',
        accessToken: 'token',
        reportId: 'WF-1',
        title: 'Problem',
        description: 'Details',
        context: { taskId: 'task-1' },
        bundlePath: '/tmp/wework-feedback-WF-1.zip',
        deleteAfterSubmit: true,
      },
    })
  })

  test('reports an unavailable channel without authentication', async () => {
    const api = createFeedbackApi('https://wegent.example.com/api', () => null)

    await expect(
      api.submit({
        reportId: 'WF-1',
        title: 'Problem',
        description: '',
        context: {},
        bundlePath: '/tmp/wework-feedback-WF-1.zip',
      })
    ).rejects.toThrow('反馈通道异常，请联系开发者')
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
