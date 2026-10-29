import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

import { ISOLATED_XVFB_OPTIONS } from './xvfb-options.mjs'

test('the isolated display retains state between readiness probe connections', () => {
  // Each xprop process closes the last X11 connection before the next opens.
  // A resetting server loses the property or rejects the connecting client.
  const result = spawnSync(
    'xvfb-run',
    [
      ...ISOLATED_XVFB_OPTIONS,
      'sh',
      '-ec',
      'xprop -root -f _WEWORK_DISPLAY_LIFETIME 8s -set _WEWORK_DISPLAY_LIFETIME checkpoint-owned; xprop -root _WEWORK_DISPLAY_LIFETIME',
    ],
    { encoding: 'utf8', timeout: 10_000 }
  )
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /_WEWORK_DISPLAY_LIFETIME\(STRING\) = "checkpoint-owned"/)
})
