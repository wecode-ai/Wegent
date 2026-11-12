import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { upgradeWriterWaitSeconds } from './upgrade-writer-wait.mjs'

test('the optional native writer observation adds no default CI delay', () => {
  assert.equal(upgradeWriterWaitSeconds(), 0)
  for (const seconds of ['0', '65', '600'])
    assert.equal(upgradeWriterWaitSeconds(seconds), Number(seconds))
})

test('writer observation rejects malformed or unbounded durations', () => {
  for (const value of ['', '-1', '0.5', '065', '601', 'Infinity', '65s'])
    assert.throws(() => upgradeWriterWaitSeconds(value), /between 0 and 600/)
})

test('the package runner rejects an invalid wait before reading release inputs', () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../../../scripts/verify-release-upgrades.mjs', import.meta.url)),
      'nonexistent-writer-verification-input',
      'macos',
      'arm64',
      'stable',
      'example/repo',
      'wework-v1.0.0',
    ],
    { env: { ...process.env, WEWORK_E2E_UPGRADE_WRITER_WAIT_SECONDS: '601' }, encoding: 'utf8' }
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Upgrade writer wait must be an integer between 0 and 600 seconds/)
  assert.doesNotMatch(result.stderr, /ENOENT/)
})
