import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createFeedbackApi } from './feedback'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

describe('createFeedbackApi', () => {
  beforeEach(() => invokeMock.mockReset())

  test('submits the exported bundle through the native command', async () => {
    invokeMock.mockResolvedValue({ report_id: 'WF-1', item_id: 'FEEDBACK-1' })
    const api = createFeedbackApi('https://feedback.example.com/v1/reports', () => 'token')

    await api.submit({
      stagingId: 'staging-1',
      title: 'Problem',
      description: 'Details',
      context: { taskId: 'task-1' },
    })

    expect(invokeMock).toHaveBeenCalledWith('submit_feedback_bundle', {
      request: {
        apiUrl: 'https://feedback.example.com/v1/reports',
        accessToken: 'token',
        stagingId: 'staging-1',
        title: 'Problem',
        description: 'Details',
        context: { taskId: 'task-1' },
      },
    })
  })

  test('supports a relative authenticated feedback endpoint', async () => {
    invokeMock.mockResolvedValue({ report_id: 'WF-2', item_id: 'FEEDBACK-2' })
    const api = createFeedbackApi('/feedback', () => 'token')

    await api.submit({
      stagingId: 'staging-2',
      title: 'Problem',
      description: '',
      context: {},
    })

    expect(invokeMock).toHaveBeenCalledWith(
      'submit_feedback_bundle',
      expect.objectContaining({
        request: expect.objectContaining({
          apiUrl: `${window.location.origin}/feedback`,
          accessToken: 'token',
        }),
      })
    )
  })

  test('does not submit without authentication', async () => {
    const api = createFeedbackApi('https://feedback.example.com/v1/reports', () => null)

    await expect(
      api.submit({
        stagingId: 'staging-3',
        title: 'Problem',
        description: '',
        context: {},
      })
    ).rejects.toThrow('反馈通道异常，请联系开发者')
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
