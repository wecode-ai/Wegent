import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'

const launcher = join(import.meta.dirname, 'run-with-xvfb.sh')

test('the isolated display retains state between readiness probe connections', () => {
  // Each xprop process closes the last X11 connection before the next opens.
  // A resetting server loses the property or rejects the connecting client.
  const result = spawnSync(
    'sh',
    [
      launcher,
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
