import { beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  instance: null as null | {
    disabled: boolean
    calls: Array<{ method: string; key?: string; value?: unknown }>
  },
}))

vi.mock('posthog-react-native', () => {
  class PostHogMock {
    disabled = false
    calls: Array<{ method: string; key?: string; value?: unknown }> = []

    constructor() {
      sdk.instance = this
    }

    ready = async () => undefined
    register = async () => undefined
    capture = () => undefined
    flush = async () => undefined
    optOut = async () => {
      this.calls.push({ method: 'optOut' })
    }
    reset = () => {
      this.calls.push({ method: 'reset' })
    }
    setPersistedProperty = (key: string, value: unknown) => {
      this.calls.push({ method: 'setPersistedProperty', key, value })
    }
    flushStorage = async () => {
      this.calls.push({ method: 'flushStorage' })
    }
    _shutdown = async () => {
      this.calls.push({ method: 'shutdown' })
    }
  }
  return {
    default: PostHogMock,
    PostHogPersistedProperty: {
      Queue: 'queue',
      AiQueue: 'ai_queue',
      AiCaptureQueue: 'ai_capture_queue',
      LogsQueue: 'logs_queue',
    },
  }
})

import { MobileTelemetryClient, sanitizeMobileCapture } from './client'

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

  it('drops an allowed event when an allowed property has an out-of-range enum value', () => {
    expect(
      sanitizeMobileCapture({
        event: 'mobile_task_started',
        properties: { execution_target: 'injected', run_count: 1 },
      })
    ).toBeNull()
    expect(
      sanitizeMobileCapture({
        event: 'mobile_frame_health',
        properties: {
          duration_ms: 1000,
          total_frames: 60,
          rendered_frames: 60,
          jank_frames: 0,
          jank_rate: 4,
          max_stall_ms: 0,
          stalls_over_100ms: 0,
          stalls_over_500ms: 0,
        },
      })
    ).toBeNull()
  })
})

describe('mobile PostHog shutdown', () => {
  beforeEach(() => {
    sdk.instance = null
  })

  it('clears every persisted queue before shutdown can flush it', async () => {
    const client = new MobileTelemetryClient()
    await client.start(
      {
        available: true,
        posthogHost: 'https://posthog.example',
        posthogKey: 'phc_test',
        sampleRate: 1,
        environment: 'test',
        releaseChannel: 'test',
        source: 'wework-mobile',
        appVersion: '1.0.0',
        appBuild: '1',
        platform: 'ios',
        osVersion: '1',
        locale: 'en-US',
      },
      'install_123',
      { telemetry_source: 'wework-mobile' }
    )
    await client.stop()
    const calls = sdk.instance!.calls
    const methods = calls.map(call => call.method)
    const queueClears = calls.filter(call => call.method === 'setPersistedProperty')
    expect(queueClears.map(call => call.key)).toEqual([
      'queue',
      'ai_queue',
      'ai_capture_queue',
      'logs_queue',
      'queue',
      'ai_queue',
      'ai_capture_queue',
      'logs_queue',
      'queue',
      'ai_queue',
      'ai_capture_queue',
      'logs_queue',
    ])
    expect(queueClears.every(call => call.value === null)).toBe(true)
    expect(methods.indexOf('optOut')).toBeLessThan(methods.indexOf('flushStorage'))
    expect(sdk.instance!.disabled).toBe(true)
    const shutdownIndex = methods.indexOf('shutdown')
    expect(methods.slice(0, shutdownIndex).lastIndexOf('setPersistedProperty')).toBeLessThan(
      shutdownIndex
    )
  })
})
