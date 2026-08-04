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
        $geoip_disable: true,
        app_version: __WEWORK_APP_VERSION__,
        execution_target: 'local',
      })
    )
    expect(posthogMocks.capture.mock.calls[0]?.[1]).not.toHaveProperty('prompt')
  })

  test('drops invalid enum values from event properties', async () => {
    const { installTelemetry, track } = await import('./client')
    await installTelemetry(true)

    track('task_started', {
      execution_target: '/Users/private/repository' as 'local',
    })

    expect(posthogMocks.capture).toHaveBeenCalledWith(
      'task_started',
      expect.objectContaining({
        $geoip_disable: true,
        app_version: __WEWORK_APP_VERSION__,
      })
    )
    expect(posthogMocks.capture.mock.calls[0]?.[1]).not.toHaveProperty('execution_target')
  })

  test('captures $ai_trace start and end with bounded properties', async () => {
    const { installTelemetry, track } = await import('./client')
    await installTelemetry(true)

    track('$ai_trace', {
      $ai_trace_id: 'task-42',
      $ai_trace_phase: 'start',
      execution_target: 'local',
    })
    track('$ai_trace', {
      $ai_trace_id: 'task-42',
      $ai_trace_phase: 'end',
      execution_target: 'cloud',
      duration_ms: 1234,
      result: 'failure',
      failure_reason: 'model_error',
      prompt: 'must not leave the device',
    } as {
      $ai_trace_id: string
      $ai_trace_phase: 'end'
      execution_target: 'cloud'
      duration_ms: number
      result: 'failure'
      failure_reason: 'model_error'
      prompt: string
    })

    expect(posthogMocks.capture).toHaveBeenCalledWith(
      '$ai_trace',
      expect.objectContaining({
        $geoip_disable: true,
        app_version: __WEWORK_APP_VERSION__,
        $ai_trace_id: 'task-42',
        $ai_trace_phase: 'start',
        execution_target: 'local',
      })
    )
    expect(posthogMocks.capture).toHaveBeenCalledWith(
      '$ai_trace',
      expect.objectContaining({
        $geoip_disable: true,
        app_version: __WEWORK_APP_VERSION__,
        $ai_trace_id: 'task-42',
        $ai_trace_phase: 'end',
        execution_target: 'cloud',
        duration_ms: 1234,
        result: 'failure',
        failure_reason: 'model_error',
      })
    )
    const endCall = posthogMocks.capture.mock.calls.find(
      call => call[0] === '$ai_trace' && call[1]?.$ai_trace_phase === 'end'
    )
    expect(endCall?.[1]).not.toHaveProperty('prompt')
  })

  test('captures $ai_generation with model, tokens, latency, and estimated cost', async () => {
    const { installTelemetry, track } = await import('./client')
    await installTelemetry(true)

    track('$ai_generation', {
      $ai_generation_id: 'gen-1',
      $ai_parent_id: 'task-42',
      $ai_model: 'gpt-4o',
      $ai_provider: 'openai',
      $ai_input_tokens: 1000,
      $ai_output_tokens: 500,
      $ai_total_tokens: 1500,
      $ai_latency: 2.5,
      $ai_latency_ms: 2500,
      $ai_cost: 0.0075,
      result: 'success',
    })

    expect(posthogMocks.capture).toHaveBeenCalledWith(
      '$ai_generation',
      expect.objectContaining({
        $geoip_disable: true,
        app_version: __WEWORK_APP_VERSION__,
        $ai_generation_id: 'gen-1',
        $ai_parent_id: 'task-42',
        $ai_model: 'gpt-4o',
        $ai_provider: 'openai',
        $ai_input_tokens: 1000,
        $ai_output_tokens: 500,
        $ai_total_tokens: 1500,
        $ai_latency: 2.5,
        $ai_latency_ms: 2500,
        $ai_cost: 0.0075,
        result: 'success',
      })
    )
  })

  test('captures $ai_feedback with allowed properties and strips task context', async () => {
    const { installTelemetry, track } = await import('./client')
    await installTelemetry(true)

    track('$ai_feedback', {
      $ai_trace_id: 'task-42',
      $ai_feedback_type: 'positive',
      source: 'task_dialog',
      attachment_count: '1',
      has_comment: true,
      note: 'must not leave the device',
      task_title: 'private project',
    } as {
      $ai_trace_id: string
      $ai_feedback_type: 'positive'
      source: 'task_dialog'
      attachment_count: '1'
      has_comment: true
      note: string
      task_title: string
    })

    expect(posthogMocks.capture).toHaveBeenCalledWith(
      '$ai_feedback',
      expect.objectContaining({
        $geoip_disable: true,
        app_version: __WEWORK_APP_VERSION__,
        $ai_trace_id: 'task-42',
        $ai_feedback_type: 'positive',
        source: 'task_dialog',
        attachment_count: '1',
        has_comment: true,
      })
    )
    const feedbackCall = posthogMocks.capture.mock.calls.find(call => call[0] === '$ai_feedback')
    expect(feedbackCall?.[1]).not.toHaveProperty('note')
    expect(feedbackCall?.[1]).not.toHaveProperty('task_title')
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
    const privateFrame = sanitized?.exception?.values?.[0]?.stacktrace?.frames?.[0]
    expect(privateFrame).toMatchObject({
      filename: '<redacted>',
      function: 'openWorkspace',
      lineno: 42,
      colno: 7,
    })
    expect(privateFrame?.abs_path).toBeUndefined()
    expect(privateFrame?.module).toBeUndefined()
    expect(privateFrame).not.toHaveProperty('context_line')
    expect(privateFrame).not.toHaveProperty('vars')
  })

  test('preserves trusted Wework stack locations and matching source map metadata', async () => {
    const { installTelemetry } = await import('./client')
    await installTelemetry(true)

    const debugId = '12345678-1234-4234-8234-123456789abc'
    const productionResource = 'tauri://localhost/assets/index-public.js?workspace=private#fragment'
    const developmentResource =
      'http://localhost:1420/node_modules/.vite/deps/tauri-event.js?v=private'
    const sentryConfig = sentryMocks.init.mock.calls[0]?.[0]
    const sanitized = sentryConfig?.beforeSend?.(
      {
        debug_meta: {
          images: [
            {
              type: 'sourcemap',
              code_file: productionResource,
              debug_id: debugId,
              future_private_field: 'private-value',
            },
            {
              type: 'sourcemap',
              code_file: 'tauri://localhost/Users/private/repository/secret.js',
              debug_id: debugId,
            },
            {
              type: 'wasm',
              code_file: productionResource,
              debug_id: debugId,
            },
          ],
        },
        exception: {
          values: [
            {
              stacktrace: {
                frames: [
                  {
                    abs_path: productionResource,
                    filename: productionResource,
                    function: '__unlisten',
                    module: '@tauri-apps/api/event',
                    lineno: 42,
                    colno: 7,
                    in_app: true,
                    debug_id: debugId,
                    context_line: 'const workspace = "private"',
                    vars: { token: 'private' },
                  },
                  {
                    filename: developmentResource,
                    function: 'listen',
                    lineno: 21,
                    colno: 3,
                  },
                  {
                    filename: 'tauri://localhost/Users/private/repository/secret.js',
                    function: 'runUserFile',
                    lineno: 9,
                    colno: 1,
                  },
                ],
              },
            },
          ],
        },
      },
      {}
    )

    const frames = sanitized?.exception?.values?.[0]?.stacktrace?.frames
    expect(frames?.[0]).toEqual({
      abs_path: 'tauri://localhost/assets/index-public.js',
      colno: 7,
      debug_id: debugId,
      filename: 'tauri://localhost/assets/index-public.js',
      function: '__unlisten',
      in_app: true,
      lineno: 42,
      module: '@tauri-apps/api/event',
    })
    expect(frames?.[1]).toMatchObject({
      filename: 'http://localhost:1420/node_modules/.vite/deps/tauri-event.js',
      function: 'listen',
      lineno: 21,
      colno: 3,
    })
    expect(frames?.[2]).toMatchObject({
      filename: '<redacted>',
      function: 'runUserFile',
      lineno: 9,
      colno: 1,
    })
    expect(sanitized?.debug_meta).toEqual({
      images: [
        {
          type: 'sourcemap',
          code_file: 'tauri://localhost/assets/index-public.js',
          debug_id: debugId,
        },
      ],
    })
    expect(JSON.stringify(sanitized)).not.toMatch(
      /workspace=private|future_private_field|secret\.js/
    )
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

  test('re-initializes SDKs with fresh instances after disable and re-enable', async () => {
    const { installTelemetry, setTelemetryEnabled, track } = await import('./client')
    await installTelemetry(true)

    await setTelemetryEnabled(false)
    posthogMocks.init.mockClear()
    sentryMocks.init.mockClear()
    posthogMocks.capture.mockClear()

    await setTelemetryEnabled(true)

    expect(posthogMocks.init).toHaveBeenCalledTimes(1)
    expect(sentryMocks.init).toHaveBeenCalledTimes(1)

    track('app_started', { surface: 'main' })
    expect(posthogMocks.capture).toHaveBeenCalledWith(
      'app_started',
      expect.objectContaining({ surface: 'main' })
    )
  })
})
