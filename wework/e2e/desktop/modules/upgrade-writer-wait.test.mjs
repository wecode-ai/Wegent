import assert from 'node:assert/strict'
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
