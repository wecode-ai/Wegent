import { describe, expect, it } from 'vitest'
import { sanitizeMobileCapture } from './client'

describe('mobile PostHog event boundary', () => {
  it('drops SDK events that are not part of the mobile analytics schema', () => {
    expect(sanitizeMobileCapture({ event: '$pageview', properties: {} })).toBeNull()
  })

  it('keeps bounded task properties and strips URLs and free text', () => {
    const event = sanitizeMobileCapture({
      event: 'mobile_task_completed',
      properties: {
        duration_ms: 1200,
        execution_target: 'local',
        result: 'success',
        run_count: 1,
        $session_id: 'session-1',
        $current_url: 'https://private.example/path',
        message: 'private prompt',
        file_path: '/Users/private/project.ts',
      },
      uuid: '3d594650-3436-4a91-8f26-4b5b53d9b7a0',
    })
    expect(event).toMatchObject({
      event: 'mobile_task_completed',
      properties: {
        duration_ms: 1200,
        execution_target: 'local',
        result: 'success',
        run_count: 1,
        $session_id: 'session-1',
      },
      uuid: '3d594650-3436-4a91-8f26-4b5b53d9b7a0',
    })
    expect(event!.properties).not.toHaveProperty('$current_url')
    expect(event!.properties).not.toHaveProperty('message')
    expect(event!.properties).not.toHaveProperty('file_path')
  })
})
