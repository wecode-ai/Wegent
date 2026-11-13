// @vitest-environment node
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'
import { startNativeAppServer } from '../e2e/desktop/modules/native-app-server.mjs'

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal()
  return {
    ...original,
    spawn: (command, args, options) =>
      command === 'synthetic-native-protocol'
        ? original.spawn(
            process.execPath,
            [
              '-e',
              `
          require('node:assert/strict').equal(process.env.ELECTRON_RUN_AS_NODE, '1')
          require('node:readline').createInterface({input:process.stdin}).on('line', line => {
            const message=JSON.parse(line)
            if(message.id) process.stdout.write(JSON.stringify({id:message.id,result:{}})+'\\n')
          })
        `,
            ],
            { ...options, env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' } }
          )
        : original.spawn(command, args, options),
  }
})

test('a native pipe failure rejects owned RPCs without crashing or waiting for their deadlines', async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-pipe-unit-'))
  let client
  try {
    client = await startNativeAppServer({
      binary: 'synthetic-native-protocol',
      home,
      workspace: home,
      timeoutMs: 5000,
    })
    const exited = once(client.child, 'exit')
    client.child.kill('SIGKILL')
    let failure
    await assert.rejects(client.rpc('thread/list', { padding: 'x'.repeat(1024 * 1024) }), error => {
      failure = error
      assert.doesNotMatch(error.message, /timed out/)
      return true
    })
    await exited
    await assert.rejects(client.rpc('thread/list', {}), error => error === failure)
  } finally {
    await client?.stop()
    await rm(home, { recursive: true, force: true })
  }
})
