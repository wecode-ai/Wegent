// @vitest-environment node

import { describe, expect, test } from 'vitest'
import { createAppUpdateError } from './app-update-error'

describe('createAppUpdateError', () => {
  test('classifies network failures without retaining an HTML proxy response', () => {
    const error = createAppUpdateError(
      new Error(
        '<!doctype html><style>body{color:red}</style><body>SGErrorDomain EOF https://internal.example/update</body>'
      ),
      'check',
      Date.parse('2026-08-31T02:22:00Z')
    )

    expect(error).toEqual({
      stage: 'check',
      kind: 'network',
      code: 'APP_UPDATE_NETWORK_UNAVAILABLE',
      occurredAt: Date.parse('2026-08-31T02:22:00Z'),
      detail: null,
    })
  })

  test('classifies Chromium connection failures as network errors', () => {
    const error = createAppUpdateError(
      new Error('net::ERR_CONNECTION_REFUSED'),
      'check',
      Date.parse('2026-08-31T03:15:56Z')
    )

    expect(error).toEqual({
      stage: 'check',
      kind: 'network',
      code: 'APP_UPDATE_NETWORK_UNAVAILABLE',
      occurredAt: Date.parse('2026-08-31T03:15:56Z'),
      detail: null,
    })
  })

  test('keeps a bounded non-sensitive technical detail for generic failures', () => {
    const error = createAppUpdateError(
      new Error(
        'The signature verification failed at https://updates.example/file.zip token=secret'
      ),
      'install',
      1
    )

    expect(error).toEqual({
      stage: 'install',
      kind: 'generic',
      code: 'APP_UPDATE_INSTALL_FAILED',
      occurredAt: 1,
      detail: 'The signature verification failed at [URL removed] token=[redacted]',
    })
  })

  test('recognizes builds that do not expose an updater endpoint', () => {
    const error = createAppUpdateError(
      new Error('Wework updater is only available in a packaged desktop app.'),
      'check',
      1
    )

    expect(error).toMatchObject({
      kind: 'unsupported',
      code: 'APP_UPDATE_UNAVAILABLE',
      detail: null,
    })
  })

  test('uses the structured preparation failure instead of the download wrapper', () => {
    const failure = Object.assign(new Error('ENOENT: missing profile'), {
      stage: 'prepare',
      code: 'UPDATE_PROFILE_MISSING',
      retryable: false,
    })
    expect(
      createAppUpdateError(new Error(failure.message, { cause: failure }), 'download')
    ).toMatchObject({
      stage: 'prepare',
      code: 'UPDATE_PROFILE_MISSING',
      retryable: false,
    })
  })

  test('reads structured host error details and rejects unknown stage names', () => {
    const failure = Object.assign(new Error('Could not extract package'), {
      code: 'UPDATE_EXTRACTION_FAILED',
      details: { stage: 'extract', retryable: true },
    })
    expect(createAppUpdateError(failure, 'download')).toMatchObject({
      stage: 'extract',
      code: 'UPDATE_EXTRACTION_FAILED',
      retryable: true,
    })
    expect(
      createAppUpdateError(Object.assign(new Error('Failure'), { stage: 'unknown' }), 'download')
    ).toMatchObject({
      stage: 'download',
      code: 'APP_UPDATE_DOWNLOAD_FAILED',
    })
  })
})
