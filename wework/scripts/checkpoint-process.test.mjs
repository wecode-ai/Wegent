import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import assert from 'node:assert/strict'
import { test } from 'vitest'

import { createCheckpointProcessRunner } from '../e2e/desktop/checkpoint-process.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const isolatedEnvironment = { WEWORK_E2E_ISOLATED_XVFB: 'true' }

function fixture(context, platform = 'linux') {
  const children = []
  const calls = []
  const pending = []
  const runner = createCheckpointProcessRunner({
    taskFlowPath: '/fixture/task-flow.mjs',
    isolatedXvfbPath: '/fixture/run-with-openbox.sh',
    platform,
    output: { stdout: { write() {} }, stderr: { write() {} } },
    spawnProcess(command, args, options) {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.closed = false
      child.finish = code => {
        if (child.closed) return
        child.closed = true
        child.emit('exit', code, null)
        child.stdout.end()
        child.stderr.end()
        child.emit('close', code, null)
      }
      child.ready = () =>
        child.stderr.write('[desktop-e2e-window-manager] ready: display=:99 pid=123\n')
      calls.push({ command, args, options })
      children.push(child)
      return child
    },
  })
  context.onTestFinished(async () => {
    // Closing a failed startup can release another queued startup.
    for (let index = 0; index <= pending.length; index += 1) {
      for (const child of children) child.finish(1)
      await tick()
    }
    await Promise.allSettled(pending)
  })
  return {
    children,
    calls,
    run(label, env = isolatedEnvironment) {
      const result = runner(['--segment', label], env, label)
      result.catch(() => {})
      pending.push(result)
      return result
    },
  }
}

test('coordinates display startup and releases it while checkpoint bodies overlap', async context => {
  const control = fixture(context)
  const one = control.run('one')
  const two = control.run('two')
  const three = control.run('three')
  await tick()
  assert.equal(control.children.length, 1)

  const first = control.children[0]
  first.stderr.write('[desktop-e2e-window-manager] rea')
  await tick()
  assert.equal(control.children.length, 1)
  first.stderr.write('dy: display=:99 pid=123\n')
  await tick()
  assert.equal(control.children.length, 2)
  assert.equal(first.closed, false)

  first.ready()
  first.finish(0)
  await tick()
  assert.equal(control.children.length, 2)
  control.children[1].ready()
  await tick()
  assert.equal(control.children.length, 3)
  assert.equal(control.children[1].closed, false)
  control.children[1].finish(0)
  control.children[2].ready()
  control.children[2].finish(0)
  assert.deepEqual(
    (await Promise.all([one, two, three])).map(result => result.code),
    [0, 0, 0]
  )
  assert.deepEqual(
    control.calls.map(call => call.command),
    ['xvfb-run', 'xvfb-run', 'xvfb-run']
  )
})

test('captures startup stderr arriving after process exit before reporting failure', async context => {
  const control = fixture(context)
  const pending = control.run('startup-failure')
  await tick()
  const child = control.children[0]
  child.emit('exit', 1, null)
  child.stderr.write('Openbox exited before registering with the isolated Xvfb display\n')
  child.finish(1)

  const result = await pending
  assert.equal(result.code, 1)
  assert.ok(result.stderrTail.includes('Openbox exited before registering'))
  assert.equal(control.calls.length, 1)
})

test('a failed display startup releases the next checkpoint without retrying', async context => {
  const control = fixture(context)
  const one = control.run('one')
  const two = control.run('two')
  await tick()
  control.children[0].finish(1)
  assert.equal((await one).code, 1)
  await tick()
  assert.equal(control.children.length, 2)
  control.children[1].ready()
  control.children[1].finish(0)
  assert.equal((await two).code, 0)
  assert.deepEqual(
    control.calls.map(call => call.args.at(-1)),
    ['one', 'two']
  )
})

test('a spawn error releases a queued display startup', async context => {
  const control = fixture(context)
  const one = control.run('one')
  const two = control.run('two')
  await tick()
  const error = new Error('xvfb-run is unavailable')
  const rejected = assert.rejects(one, result => result === error)
  control.children[0].emit('error', error)
  await rejected
  control.children[0].finish(1)
  await tick()
  assert.equal(control.children.length, 2)
  control.children[1].ready()
  control.children[1].finish(0)
  assert.equal((await two).code, 0)
})

for (const [platform, environment] of [
  ['darwin', isolatedEnvironment],
  ['linux', {}],
]) {
  test(`keeps ${platform} non-isolated processes parallel`, async context => {
    const control = fixture(context, platform)
    const pending = [control.run('one', environment), control.run('two', environment)]
    await tick()
    assert.equal(control.children.length, 2)
    assert.equal(
      control.calls.every(call => call.command === process.execPath),
      true
    )
    for (const child of control.children) child.finish(0)
    assert.deepEqual(
      (await Promise.all(pending)).map(result => result.code),
      [0, 0]
    )
  })
}
