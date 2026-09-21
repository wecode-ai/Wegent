import { describe, expect, test } from 'vitest'

import {
  isTrustedIsolatedSurfaceAttachment,
  type TrustedIsolatedSurfacePolicy,
} from './isolated-surface-security.js'

const ORIGIN = 'http://127.0.0.1:1420'
const POLICY: TrustedIsolatedSurfacePolicy = {
  path: '/preview',
  partitionPrefix: 'wework-isolated-preview:',
  identityParameter: 'id',
  modeParameter: 'surface',
  modeValue: 'isolated',
}

describe('isolated surface security', () => {
  test.each([
    '/preview?id=item-1&surface=isolated',
    '/wework/app/preview?id=item-1&surface=isolated',
  ])('accepts a configured child route at %s', path => {
    expect(
      isTrustedIsolatedSurfaceAttachment(
        { partition: 'wework-isolated-preview:test-surface', src: `${ORIGIN}${path}` },
        `${ORIGIN}/`,
        [POLICY]
      )
    ).toBe(true)
  })

  test.each([
    { partition: '', src: `${ORIGIN}/preview?id=item-1&surface=isolated` },
    {
      partition: 'wework-isolated-preview:test-surface',
      src: 'https://other.test/preview?id=item-1&surface=isolated',
    },
    {
      partition: 'wework-isolated-preview:test-surface',
      src: `${ORIGIN}/settings?id=item-1&surface=isolated`,
    },
    {
      partition: 'wework-isolated-preview:test-surface',
      src: `${ORIGIN}/preview?surface=isolated`,
    },
    {
      partition: 'wework-isolated-preview:test-surface',
      src: `${ORIGIN}/preview?id=item-1&surface=isolated&token=secret`,
    },
  ])('rejects an untrusted attachment %#', params => {
    expect(isTrustedIsolatedSurfaceAttachment(params, `${ORIGIN}/`, [POLICY])).toBe(false)
  })

  test('rejects all isolated attachments without a bundled policy', () => {
    expect(
      isTrustedIsolatedSurfaceAttachment(
        {
          partition: 'wework-isolated-preview:test-surface',
          src: `${ORIGIN}/preview?id=item-1&surface=isolated`,
        },
        `${ORIGIN}/`,
        []
      )
    ).toBe(false)
  })
})
