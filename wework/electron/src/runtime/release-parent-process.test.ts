import { realpath } from 'node:fs/promises'
import { expect, test } from 'vitest'
import { processExecutable } from './release-parent-process.js'

test('reads the actual OS executable identity without command-line arguments', async () => {
  expect(await processExecutable(process.pid)).toBe(await realpath(process.execPath))
})

test('rejects invalid process identities before invoking an OS command', async () => {
  for (const pid of [0, -1, 1.5, NaN]) {
    await expect(processExecutable(pid)).rejects.toThrow('Invalid release process identity')
  }
})
