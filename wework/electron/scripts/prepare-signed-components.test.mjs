import { describe, expect, test } from 'vitest'

import {
  SIGNED_COMPONENT_POLICY_VERSION,
  signedComponentCodesignArguments,
} from './prepare-signed-components.mjs'

describe('signed component codesign arguments', () => {
  test('preserves entitlements required by nested runtimes', () => {
    expect(
      signedComponentCodesignArguments('Developer ID Application: Example', '/tmp/component')
    ).toEqual([
      '--force',
      '--sign',
      'Developer ID Application: Example',
      '--timestamp',
      '--options',
      'runtime',
      '--preserve-metadata=entitlements',
      '/tmp/component',
    ])
  })

  test('invalidates signed component caches created without preserved entitlements', () => {
    expect(SIGNED_COMPONENT_POLICY_VERSION).toBe(2)
  })
})
