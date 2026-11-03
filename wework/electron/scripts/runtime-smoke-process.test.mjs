import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { expect, test } from 'vitest'
import { terminate } from './runtime-smoke-process.mjs'

test('finishes cleanup when the runtime already exited from a signal', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  })
  await once(child, 'spawn')
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  await exited
  expect(child.signalCode).toBe('SIGTERM')
  await terminate(child)
}, 1_000)
