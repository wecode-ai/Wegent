import { beforeEach, describe, expect, test, vi } from 'vitest'

const posthogMocks = vi.hoisted(() => ({
  capture: vi.fn(),
  init: vi.fn(),
  optIn: vi.fn(),
  optOut: vi.fn(),
  reset: vi.fn(),
}))
const sentryMocks = vi.hoisted(() => ({
  browserTracingIntegration: vi.fn(() => ({ name: 'browser-tracing' })),
  captureException: vi.fn(),
  close: vi.fn(),
  init: vi.fn(),
  setTag: vi.fn(),
  setUser: vi.fn(),
}))

vi.mock('posthog-js', () => ({
  default: {
    init: posthogMocks.init,
  },
}))

vi.mock('@sentry/react', () => sentryMocks)

describe('telemetry client', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
    Object.values(posthogMocks).forEach(mock => mock.mockReset())
    Object.values(sentryMocks).forEach(mock => mock.mockReset())
    posthogMocks.init.mockReturnValue({
      capture: posthogMocks.capture,
      opt_in_capturing: posthogMocks.optIn,
      opt_out_capturing: posthogMocks.optOut,
      reset: posthogMocks.reset,
    })
    sentryMocks.close.mockResolvedValue(true)
    vi.stubEnv('VITE_WEWORK_POSTHOG_KEY', 'project-key')
    vi.stubEnv('VITE_WEWORK_SENTRY_DSN', 'https://public@example.invalid/1')
  })

  test('does not initialize or capture while disabled', async () => {
    const { installTelemetry, track } = await import('./client')

    await installTelemetry(false)
    track('app_started', { surface: 'main' })

    expect(posthogMocks.init).not.toHaveBeenCalled()
    expect(sentryMocks.init).not.toHaveBeenCalled()
    expect(posthogMocks.capture).not.toHaveBeenCalled()
  })

  test('captures only allowlisted event properties', async () => {
    const { installTelemetry, track } = await import('./client')
    await installTelemetry(true)

    track('task_started', {
      execution_target: 'local',
      prompt: 'must not leave the device',
    } as { execution_target: 'local'; prompt: string })

    expect(posthogMocks.capture).toHaveBeenCalledWith(
      'task_started',
      expect.objectContaining({
        app_version: __WEWORK_APP_VERSION__,
        execution_target: 'local',
      })
    )
    expect(posthogMocks.capture.mock.calls[0]?.[1]).not.toHaveProperty('prompt')
  })

  test('uses immediate requests and disables persistence after opt-out', async () => {
    const { installTelemetry } = await import('./client')
    await installTelemetry(true)

    expect(posthogMocks.init.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        opt_out_persistence_by_default: true,
        person_profiles: 'never',
        request_batching: false,
      })
    )
  })

  test('strips SDK URL properties and rejects SDK-generated events before sending', async () => {
    const { installTelemetry } = await import('./client')
    await installTelemetry(true)

    const posthogConfig = posthogMocks.init.mock.calls[0]?.[1]
    const beforeSend = posthogConfig?.before_send
    expect(typeof beforeSend).toBe('function')

    const sanitized = beforeSend({
      uuid: 'event-uuid',
      event: 'task_started',
      properties: {
        app_version: __WEWORK_APP_VERSION__,
        execution_target: 'local',
        distinct_id: 'anonymous-installation',
        $lib: 'web',
        $lib_version: '1.0.0',
        $current_url: 'http://localhost/private/project/42?token=secret',
        $pathname: '/private/project/42',
        $referrer: 'https://private.example/repository',
        prompt: 'private prompt',
        file_path: '/Users/private/repository/secret.ts',
      },
      $set: { email: 'private@example.com' },
    })

    expect(sanitized?.properties).toEqual({
      app_version: __WEWORK_APP_VERSION__,
      execution_target: 'local',
      distinct_id: 'anonymous-installation',
      $lib: 'web',
      $lib_version: '1.0.0',
    })
    expect(sanitized?.$set).toBeUndefined()
    expect(
      beforeSend({
        uuid: 'identify-uuid',
        event: '$identify',
        properties: {
          distinct_id: 'anonymous-installation',
          $anon_distinct_id: 'previous-anonymous-id',
        },
      })
    ).toBeNull()
  })

  test('removes request, breadcrumb, message, context and source paths from Sentry events', async () => {
    const { installTelemetry } = await import('./client')
    await installTelemetry(true)

    const sentryConfig = sentryMocks.init.mock.calls[0]?.[0]
    const sanitized = sentryConfig?.beforeSend?.(
      {
        message: 'private prompt and token',
        transaction: '/project/private-id',
        request: {
          url: 'https://private.example/task/42?token=secret',
          headers: { Authorization: 'Bearer secret' },
          data: 'private request body',
        },
        breadcrumbs: [
          {
            message: 'opened /Users/private/repository',
            data: { prompt: 'private prompt' },
          },
        ],
        extra: {
          file_path: '/Users/private/repository/secret.ts',
          prompt: 'private prompt',
        },
        user: {
          email: 'private@example.com',
          id: 'private-user',
        },
        tags: {
          installation_id: 'anonymous-installation',
          private_workspace: 'secret-project',
        },
        threads: {
          values: [
            {
              id: 42,
              name: 'private-thread',
              stacktrace: {
                frames: [
                  {
                    filename: '/Users/private/repository/thread-secret.ts',
                    context_line: 'const password = "secret"',
                  },
                ],
              },
            },
          ],
        },
        exception: {
          values: [
            {
              type: 'TypeError',
              value: 'Failed to open /Users/private/repository/secret.ts',
              module: 'private.repository',
              thread_id: 'private-thread',
              mechanism: {
                type: 'instrument',
                data: { target: 'private-workspace' },
                source: 'private-handler',
              },
              stacktrace: {
                frames: [
                  {
                    function: 'openWorkspace',
                    module: 'private.repository',
                    module_metadata: { path: '/Users/private/repository' },
                    filename: '/Users/private/repository/secret.ts',
                    abs_path: '/Users/private/repository/secret.ts',
                    context_line: 'const token = "secret"',
                    pre_context: ['private prompt'],
                    post_context: ['private response'],
                    vars: { token: 'secret' },
                    lineno: 42,
                    colno: 7,
                  },
                ],
              },
            },
          ],
        },
      },
      {}
    )

    expect(sanitized).not.toHaveProperty('message')
    expect(sanitized).not.toHaveProperty('transaction')
    expect(sanitized).not.toHaveProperty('request')
    expect(sanitized).not.toHaveProperty('breadcrumbs')
    expect(sanitized).not.toHaveProperty('extra')
    expect(sanitized).not.toHaveProperty('user')
    expect(sanitized).not.toHaveProperty('threads')
    expect(sanitized?.tags).toEqual({
      installation_id: 'anonymous-installation',
    })
    expect(sanitized?.exception?.values?.[0]?.type).toBe('Error')
    expect(sanitized?.exception?.values?.[0]?.value).toBe('Wework error')
    expect(sanitized?.exception?.values?.[0]?.stacktrace?.frames?.[0]).toEqual({
      function: 'openWorkspace',
      lineno: 42,
      colno: 7,
    })
  })

  test('removes routes, URLs and span attributes from Sentry performance events', async () => {
    const { installTelemetry } = await import('./client')
    await installTelemetry(true)

    const sentryConfig = sentryMocks.init.mock.calls[0]?.[0]
    const sanitized = sentryConfig?.beforeSendTransaction?.(
      {
        type: 'transaction',
        transaction: '/workspace/private-project',
        request: {
          url: 'https://private.example/workspace?token=secret',
        },
        user: { email: 'private@example.com' },
        contexts: {
          trace: {
            trace_id: 'trace-id',
            span_id: 'span-id',
            tags: {
              private_workspace: 'secret-project',
            },
            links: [
              {
                trace_id: 'private-trace',
                span_id: 'private-span',
                attributes: { prompt: 'private prompt' },
              },
            ],
            future_private_field: 'private-value',
            data: {
              url: 'https://private.example/workspace',
              prompt: 'private prompt',
            },
          },
          runtime: {
            name: 'private runtime',
          },
        },
        tags: {
          installation_id: 'anonymous-installation',
          private_workspace: 'secret-project',
        },
        spans: [
          {
            span_id: 'child-span',
            trace_id: 'trace-id',
            start_timestamp: 1,
            timestamp: 2,
            data: {
              'http.url': 'https://private.example/workspace',
              prompt: 'private prompt',
            },
            description: 'GET /workspace/private-project',
          },
        ],
      },
      {}
    )
    const sanitizedSpan = sentryConfig?.beforeSendSpan?.({
      span_id: 'child-span',
      trace_id: 'trace-id',
      start_timestamp: 1,
      data: {
        'http.url': 'https://private.example/workspace',
        prompt: 'private prompt',
      },
      description: 'GET /workspace/private-project',
    })

    expect(sanitized?.transaction).toBe('Wework transaction')
    expect(sanitized?.request).toBeUndefined()
    expect(sanitized?.user).toBeUndefined()
    expect(sanitized?.contexts).toEqual({
      trace: {
        op: undefined,
        origin: undefined,
        parent_span_id: undefined,
        trace_id: 'trace-id',
        span_id: 'span-id',
        status: undefined,
      },
    })
    expect(sanitized?.tags).toEqual({
      installation_id: 'anonymous-installation',
    })
    expect(sanitized?.spans?.[0]?.data).toEqual({})
    expect(sanitized?.spans?.[0]?.description).toBeUndefined()
    expect(sanitizedSpan?.data).toEqual({})
    expect(sanitizedSpan?.description).toBeUndefined()
    expect(JSON.stringify({ sanitized, sanitizedSpan })).not.toMatch(
      /private|prompt|token|workspace\?/
    )
  })

  test('drops plugin and board identifiers from feature events', async () => {
    const { installTelemetry, track } = await import('./client')
    await installTelemetry(true)

    track('plugin_installed', {
      source: 'local',
      plugin_name: 'private-plugin',
      marketplace_id: 'private-marketplace',
    } as { source: 'local'; plugin_name: string; marketplace_id: string })
    track('board_item_created', {
      has_parent: true,
      source: 'cloud',
      item_id: 'secret-item',
    } as { has_parent: true; source: 'cloud'; item_id: string })

    expect(posthogMocks.capture.mock.calls[0]?.[1]).not.toHaveProperty('plugin_name')
    expect(posthogMocks.capture.mock.calls[0]?.[1]).not.toHaveProperty('marketplace_id')
    expect(posthogMocks.capture.mock.calls[1]?.[1]).not.toHaveProperty('item_id')
  })

  test('drops resource details from generic feature action events', async () => {
    const { installTelemetry, track } = await import('./client')
    await installTelemetry(true)

    track('feature_action_completed', {
      domain: 'project_space_file',
      action: 'upload',
      file_name: 'private-plan.md',
      project_id: 'private-project',
    } as {
      domain: 'project_space_file'
      action: 'upload'
      file_name: string
      project_id: string
    })

    expect(posthogMocks.capture).toHaveBeenCalledWith(
      'feature_action_completed',
      expect.objectContaining({ domain: 'project_space_file', action: 'upload' })
    )
    expect(posthogMocks.capture.mock.calls[0]?.[1]).not.toHaveProperty('file_name')
    expect(posthogMocks.capture.mock.calls[0]?.[1]).not.toHaveProperty('project_id')
  })

  test('clears identity and stops both SDKs when disabled', async () => {
    const { installTelemetry, setTelemetryEnabled } = await import('./client')
    await installTelemetry(true)

    await setTelemetryEnabled(false)

    expect(posthogMocks.reset).toHaveBeenCalledWith(true)
    expect(posthogMocks.optOut).toHaveBeenCalled()
    expect(posthogMocks.reset.mock.invocationCallOrder[0]).toBeLessThan(
      posthogMocks.optOut.mock.invocationCallOrder[0]
    )
    expect(sentryMocks.setUser).toHaveBeenCalledWith(null)
    expect(sentryMocks.close).toHaveBeenCalledWith(0)
  })
})
