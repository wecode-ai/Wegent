import { describe, expect, test } from 'vitest'
import { createFeedbackApi } from './feedback'

describe('createFeedbackApi', () => {
  test('reports that feedback submission is unavailable in the Electron host', async () => {
    const api = createFeedbackApi('https://feedback.example.com/v1/reports')

    await expect(
      api.submit({
        stagingId: 'staging-1',
        title: 'Problem',
        description: 'Details',
        context: { taskId: 'task-1' },
      })
    ).rejects.toThrow('Feedback bundle submission is not available in the Electron desktop host')
  })
})
