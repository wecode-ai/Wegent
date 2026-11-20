// @vitest-environment node

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import { test } from 'vitest'
import { appendProcessOutput, flushProcessOutput } from '../e2e/desktop/process-output.mjs'

test('drains interleaved stdout/stderr and appends after restarting a process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-process-output-'))
  try {
    const destination = join(directory, 'process.log')
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    appendProcessOutput(stdout, destination)
    appendProcessOutput(stderr, destination)
    appendProcessOutput(null, destination)
    stdout.write('first\n')
    stderr.end('second\n')
    stdout.end('third\n')
    await flushProcessOutput()
    const restarted = new PassThrough()
    appendProcessOutput(restarted, destination)
    restarted.end('fourth\n')
    await flushProcessOutput()
    assert.equal(await readFile(destination, 'utf8'), 'first\nsecond\nthird\nfourth\n')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function message(worker, type) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.off('message', receive)
      worker.off('error', failed)
      worker.off('exit', exited)
    }
    const receive = value => {
      if (value.type !== type) return
      cleanup()
      resolve(value)
    }
    const failed = error => {
      cleanup()
      reject(error)
    }
    const exited = code => failed(new Error(`Log worker exited before ${type}: ${code}`))
    worker.on('message', receive)
    worker.once('error', failed)
    worker.once('exit', exited)
  })
}

test.each(['none', 'before-flush', 'during-flush'])(
  'serves control requests and drains held log I/O (source failure: %s)',
  async failSource => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-slow-log-'))
    const destination = join(directory, 'process.log')
    const gate = new Int32Array(new SharedArrayBuffer(4))
    const worker = new Worker(
      `
    const fs = require('node:fs')
    const { syncBuiltinESMExports } = require('node:module')
    const { parentPort, workerData } = require('node:worker_threads')
    const { PassThrough } = require('node:stream')
    const gate = new Int32Array(workerData.gate)
    let announced = false
    const held = () => {
      if (announced) return
      announced = true
      parentPort.postMessage({type: 'held'})
    }
    const append = fs.appendFileSync
    fs.appendFileSync = (...args) => {
      held()
      Atomics.wait(gate, 0, 0)
      return append(...args)
    }
    const create = fs.createWriteStream
    fs.createWriteStream = (path, options) => create(path, {
      ...options,
      fs: {...fs, write(...args) {
        held()
        Promise.resolve(Atomics.waitAsync(gate, 0, 0).value).then(() => fs.write(...args))
      }},
    })
    syncBuiltinESMExports()
    ;(async () => {
      const capture = await import(workerData.moduleUrl)
      const source = new PassThrough()
      capture.appendProcessOutput(source, workerData.destination)
      parentPort.on('message', async command => {
        if (command === 'ping') {
          parentPort.postMessage({type: 'pong', held: Atomics.load(gate, 0) === 0,
            paused: source.isPaused()})
        } else if (command === 'fail-source') {
          let settled = false
          const messages = error => [error.message, ...(error.errors || []).flatMap(messages)]
          if (workerData.failSource === 'before-flush') {
            source.destroy(new Error('source failed'))
            await new Promise(setImmediate)
          }
          capture.flushProcessOutput().then(
            () => { settled = true; parentPort.postMessage({type: 'complete', errors: []}) },
            error => {
              settled = true
              parentPort.postMessage({type: 'complete', errors: messages(error)})
            },
          )
          if (workerData.failSource === 'during-flush') source.destroy(new Error('source failed'))
          setImmediate(() => parentPort.postMessage({type: 'failed-source', settled}))
        } else {
          await capture.flushProcessOutput()
          parentPort.postMessage({type: 'complete'})
          parentPort.close()
        }
      })
      if (workerData.failSource !== 'none') source.write(Buffer.alloc(128 * 1024, 120))
      else source.end(Buffer.alloc(128 * 1024, 120))
    })().catch(error => { throw error })
    `,
      {
        eval: true,
        workerData: {
          gate: gate.buffer,
          failSource,
          destination,
          moduleUrl: new URL('../e2e/desktop/process-output.mjs', import.meta.url).href,
        },
      }
    )
    const release = () => {
      Atomics.store(gate, 0, 1)
      Atomics.notify(gate, 0)
    }
    // Bound a broken synchronous implementation without requiring a slow host to meet a deadline.
    const watchdog = setTimeout(release, 3000)
    try {
      await message(worker, 'held')
      const response = message(worker, 'pong')
      worker.postMessage('ping')
      assert.deepEqual(await response, { type: 'pong', held: true, paused: true })
      const complete = message(worker, 'complete')
      if (failSource !== 'none') {
        const failed = message(worker, 'failed-source')
        worker.postMessage('fail-source')
        assert.deepEqual(await failed, { type: 'failed-source', settled: false })
      }
      release()
      if (failSource === 'none') worker.postMessage('finish')
      const result = await complete
      if (failSource !== 'none') assert.ok(result.errors.includes('source failed'))
      assert.deepEqual(await readFile(destination), Buffer.alloc(128 * 1024, 120))
    } finally {
      clearTimeout(watchdog)
      release()
      await worker.terminate()
      await rm(directory, { recursive: true, force: true })
    }
  },
  10_000
)

test.each([false, true])(
  'drains other logs before rejecting a failed destination (error before flush: %s)',
  async failBeforeFlush => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-log-error-'))
    const healthy = new PassThrough()
    let flushing
    try {
      const source = new PassThrough()
      const failed = new Promise(resolve => source.once('close', resolve))
      const destination = join(directory, 'healthy.log')
      appendProcessOutput(healthy, destination)
      healthy.write('before\n')
      appendProcessOutput(source, join(directory, 'missing', 'process.log'))
      source.write('required evidence')
      if (failBeforeFlush) {
        await failed
        await setImmediate()
      }
      let settled = false
      flushing = flushProcessOutput().then(
        () => {
          settled = true
          return null
        },
        error => {
          settled = true
          return error
        }
      )
      await failed
      await setImmediate()
      assert.equal(settled, false, 'A failed destination must not abandon other pending logs')
      healthy.end('after\n')
      const error = await flushing
      assert.ok(error instanceof AggregateError)
      assert.ok(error.errors.some(item => item.code === 'ENOENT'))
      assert.equal(await readFile(destination, 'utf8'), 'before\nafter\n')
    } finally {
      healthy.end()
      await flushing
      await rm(directory, { recursive: true, force: true })
    }
  }
)
