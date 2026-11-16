import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock, test } from 'node:test'
import {
  inspectBeforeStart,
  inspectRunningApp,
  readConnectedApplicationPid,
  readInspectorEndpoint,
} from './inspect-before-start.mjs'

test('observes an unpaused child endpoint after entry without a debugger handshake', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-unpaused-inspector-'))
  const entry = join(directory, 'host.cjs')
  await writeFile(
    entry,
    'globalThis.started = true; setInterval(() => {}, 1000); console.log("ready")'
  )
  const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', entry], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit')
  const ready = once(child.stdout, 'data', { signal: AbortSignal.timeout(10_000) })
  try {
    const [endpoint, [output]] = await Promise.all([readInspectorEndpoint(child), ready])
    assert.equal(output.toString().trim(), 'ready')
    assert.equal(
      await inspectRunningApp(new URL(endpoint).port, child.pid, 'globalThis.started', () => {}),
      true
    )
  } finally {
    child.kill('SIGKILL')
    await exited
    await rm(directory, { recursive: true, force: true })
  }
})

test('registered handoff endpoints select the exact host without mutating other live hosts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-inspector-registry-'))
  const entry = join(directory, 'host.cjs')
  await writeFile(entry, 'setInterval(() => {}, 1000); console.log("ready")')
  const hosts = []
  try {
    for (let index = 0; index < 2; index++) {
      const child = spawn(process.execPath, ['--inspect-brk=127.0.0.1:0', entry], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const exited = once(child, 'exit')
      const ready = once(child.stdout, 'data', { signal: AbortSignal.timeout(10_000) })
      const host = { child, exited }
      hosts.push(host)
      const endpoint = await inspectBeforeStart(child, 'globalThis.visited = false', () => {})
      await ready
      host.port = new URL(endpoint).port
    }
    const [old, current] = hosts
    const ports = hosts.map(host => host.port)
    assert.equal(
      await inspectRunningApp(ports, current.child.pid, 'globalThis.visited = true', () => {}),
      true
    )
    assert.equal(
      await inspectRunningApp(old.port, old.child.pid, 'globalThis.visited', () => {}),
      false
    )
    await assert.rejects(
      inspectRunningApp(ports, process.pid, 'globalThis.visited = true', () => {}),
      /exactly one registered inspector/
    )
    const request = globalThis.fetch
    const events = []
    let closed = false
    globalThis.fetch = async (...args) => {
      const response = await request(...args)
      if (!closed && String(args[0]) === `http://127.0.0.1:${old.port}/json/list`) {
        const targets = await response.json()
        old.child.kill('SIGKILL')
        await old.exited
        closed = true
        return Response.json(targets)
      }
      return response
    }
    try {
      assert.equal(
        await inspectRunningApp(ports, current.child.pid, 'true', (...event) => events.push(event)),
        true
      )
      assert.ok(
        events.some(
          event => event[0] === '[desktop-e2e-inspector] endpoint closed during identity check'
        )
      )
    } finally {
      globalThis.fetch = request
    }
    old.child.kill('SIGKILL')
    await old.exited
    assert.equal(
      await inspectRunningApp(
        ports,
        current.child.pid,
        selected => JSON.stringify(selected),
        () => {}
      ),
      current.port
    )
    await assert.rejects(
      inspectRunningApp([...ports, 'invalid'], current.child.pid, 'true', () => {}),
      /registered TCP port/
    )
  } finally {
    await Promise.all(
      hosts.map(async ({ child, exited }) => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await exited
      })
    )
    await rm(directory, { recursive: true, force: true })
  }
})

test('reads historical native host identity without requiring an open process window', async () => {
  assert.equal(
    await readConnectedApplicationPid({
      async command(name, selector) {
        assert.equal(name, 'getProcessExplorerWindowSnapshot')
        assert.equal(selector, 'body')
        return JSON.stringify({ exists: false, visible: false, applicationPid: 42 })
      },
    }),
    42
  )
})

test('rejects missing, nonnumeric, or invalid native application process IDs', async () => {
  for (const applicationPid of [undefined, null, '42', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      readConnectedApplicationPid({
        async command() {
          return JSON.stringify({ applicationPid })
        },
      }),
      /no valid application process ID/
    )
  }
})

test('awaits native asynchronous assertions only after startup and verifies the current host PID', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-running-inspector-'))
  const entry = join(directory, 'running.cjs')
  await writeFile(entry, "setInterval(() => {}, 1000); console.log('ready')")
  const child = spawn(process.execPath, ['--inspect-brk=127.0.0.1:0', entry], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit')
  const ready = once(child.stdout, 'data', { signal: AbortSignal.timeout(10_000) })
  try {
    const socketUrl = await inspectBeforeStart(child, 'globalThis.started = true', () => {})
    await ready
    const port = new URL(socketUrl).port
    assert.deepEqual(
      await inspectRunningApp(
        port,
        child.pid,
        'Promise.resolve({started: globalThis.started, authenticated: true})',
        () => {}
      ),
      { started: true, authenticated: true }
    )
    await assert.rejects(
      inspectRunningApp(port, child.pid + 1, 'process.exit(1)', () => {}),
      /another release process/
    )
  } finally {
    child.kill()
    await exited
    await rm(directory, { recursive: true, force: true })
  }
})

/** Keep protocol regressions on a real, isolated V8 Inspector with deterministic GC. */
async function withCollectableInspector(operation) {
  const directory = await mkdtemp(join(tmpdir(), 'wework-inspector-promise-gc-'))
  const entry = join(directory, 'running.cjs')
  await writeFile(
    entry,
    `globalThis.finishNativeAssertion = reference => {
      global.gc()
      setImmediate(() => {
        global.gc()
        reference.deref()?.complete({ completed: true })
      })
    }
    setInterval(() => {}, 1000)
    console.log('ready')`
  )
  const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '--expose-gc', entry], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit')
  const ready = once(child.stdout, 'data', { signal: AbortSignal.timeout(10_000) })
  try {
    const [endpoint] = await Promise.all([readInspectorEndpoint(child), ready])
    await operation(new URL(endpoint).port, child)
  } finally {
    child.kill('SIGKILL')
    await exited
    await rm(directory, { recursive: true, force: true })
  }
}

test('retains an asynchronous native assertion across garbage collection until its result is delivered', async () => {
  await withCollectableInspector(async (port, child) => {
    const expression = `(() => {
      let complete
      const assertion = new Promise(resolve => { complete = resolve })
      assertion.complete = complete
      setImmediate(globalThis.finishNativeAssertion, new WeakRef(assertion))
      return assertion
    })()`
    for (const source of [
      expression,
      `process.getBuiltinModule('node:vm').runInNewContext(${JSON.stringify(expression)}, {
        WeakRef, setImmediate, finishNativeAssertion: globalThis.finishNativeAssertion
      })`,
    ]) {
      const events = []
      assert.deepEqual(
        await inspectRunningApp(port, child.pid, source, (...event) => events.push(event)),
        { completed: true }
      )
      assert.ok(
        events.some(
          event =>
            event[0].endsWith('response') &&
            event[1] === 'Runtime.releaseObjectGroup' &&
            event[2] === 'ok'
        )
      )
      assert.equal(events.at(-1)[0], '[desktop-e2e-inspector] disconnected')
    }
  })
})

test('preserves primitive, ordinary object and asynchronous rejection results and releases their objects', async () => {
  await withCollectableInspector(async (port, child) => {
    for (const [expression, expected] of [
      ['undefined', undefined],
      ['null', null],
      ['false', false],
      [
        '({ nested: { value: 42 }, values: [true, null] })',
        { nested: { value: 42 }, values: [true, null] },
      ],
      ['({ then(resolve) { resolve({ adopted: true }) } })', { adopted: true }],
      [
        `(() => {
          globalThis.value = 'original value'
          globalThis.pending = 'original pending'
          globalThis.assertionCalls = (globalThis.assertionCalls ?? 0) + 1
          return { value, pending, calls: globalThis.assertionCalls, global: this === globalThis }
        })()`,
        { value: 'original value', pending: 'original pending', calls: 1, global: true },
      ],
      [
        'globalThis.commaCalls = (globalThis.commaCalls ?? 0) + 1, Promise.resolve({ calls: globalThis.commaCalls })',
        { calls: 1 },
      ],
      [
        `(() => {
          globalThis.resultThenReads = 0
          const result = { completed: true }
          Object.defineProperty(result, 'then', { get() {
            if (++globalThis.resultThenReads > 1) throw new Error('Result was adopted twice')
          } })
          return Promise.resolve(result)
        })()`,
        { completed: true },
      ],
      ['globalThis.resultThenReads', 1],
    ]) {
      const events = []
      assert.deepEqual(
        await inspectRunningApp(port, child.pid, expression, (...event) => events.push(event)),
        expected
      )
      assert.ok(
        events.some(
          event =>
            event[0].endsWith('response') &&
            event[1] === 'Runtime.releaseObjectGroup' &&
            event[2] === 'ok'
        )
      )
      assert.equal(events.at(-1)[0], '[desktop-e2e-inspector] disconnected')
    }
    for (const [expression, message] of [
      [
        '(() => { throw new Error("native assertion failure") })()',
        /^Inspector setup failed: Uncaught$/,
      ],
      ...[
        'Promise.reject(new Error("native assertion failure"))',
        `process.getBuiltinModule('node:vm').runInNewContext('Promise.reject(new Error("native assertion failure"))')`,
        '({ then(resolve, reject) { reject(new Error("native assertion failure")) } })',
      ].map(expression => [
        expression,
        /^Inspector setup failed: Uncaught \(in promise\) Error: native assertion failure$/,
      ]),
    ]) {
      const events = []
      await assert.rejects(
        inspectRunningApp(port, child.pid, expression, (...event) => events.push(event)),
        { message }
      )
      assert.ok(
        events.some(
          event =>
            event[0].endsWith('response') &&
            event[1] === 'Runtime.releaseObjectGroup' &&
            event[2] === 'ok'
        )
      )
      assert.equal(events.at(-1)[0], '[desktop-e2e-inspector] disconnected')
    }
  })
})

test('shares the original evaluation deadline across binding and awaiting a Promise', async () => {
  await withCollectableInspector(async (port, child) => {
    let now = 0
    let method
    const timers = []
    const originalTimeout = globalThis.setTimeout
    const clock = mock.method(performance, 'now', () => now)
    const timer = mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
      timers.push({ method, delay })
      return originalTimeout(callback, delay, ...args)
    })
    try {
      assert.deepEqual(
        await inspectRunningApp(
          port,
          child.pid,
          'Promise.resolve({ value: 42 })',
          (event, command) => {
            if (event !== '[desktop-e2e-inspector] command') return
            method = command
            if (command === 'Runtime.evaluate') now += 6_000
          }
        ),
        { value: 42 }
      )
      assert.equal(timers.find(entry => entry.method === 'Runtime.awaitPromise').delay, 4_000)
      assert.equal(
        timers.find(entry => entry.method === 'Runtime.releaseObjectGroup').delay,
        10_000
      )
    } finally {
      timer.mock.restore()
      clock.mock.restore()
    }
  })
})

test('a consumed evaluation deadline releases its retained Promise without starting another wait', async () => {
  await withCollectableInspector(async (port, child) => {
    let now = 0
    let evaluations = 0
    const events = []
    const clock = mock.method(performance, 'now', () => now)
    try {
      await assert.rejects(
        inspectRunningApp(port, child.pid, 'new Promise(() => {})', (...event) => {
          events.push(event)
          if (
            event[0] === '[desktop-e2e-inspector] response' &&
            event[1] === 'Runtime.evaluate' &&
            ++evaluations === 2
          )
            now += 10_001
        }),
        /Inspector command timed out: Runtime.evaluate/
      )
      assert.equal(
        events.some(event => event[1] === 'Runtime.awaitPromise'),
        false
      )
      assert.ok(
        events.some(
          event =>
            event[0].endsWith('response') &&
            event[1] === 'Runtime.releaseObjectGroup' &&
            event[2] === 'ok'
        )
      )
      assert.equal(events.at(-1)[0], '[desktop-e2e-inspector] disconnected')
    } finally {
      clock.mock.restore()
    }
  })
})

test('disconnect releases groups after cleanup transport failure without masking an assertion failure', async () => {
  await withCollectableInspector(async (port, child) => {
    const originalWebSocket = globalThis.WebSocket
    globalThis.WebSocket = class extends originalWebSocket {
      send(data) {
        if (JSON.parse(data).method === 'Runtime.releaseObjectGroup')
          throw new Error('injected cleanup transport failure')
        return super.send(data)
      }
    }
    const events = []
    try {
      await assert.rejects(
        inspectRunningApp(
          port,
          child.pid,
          'Promise.reject(new Error("native assertion failure"))',
          (...event) => events.push(event)
        ),
        /Inspector setup failed: Uncaught.*native assertion failure/
      )
      assert.ok(events.some(event => event[0].endsWith('object cleanup deferred to disconnect')))
      assert.equal(events.at(-1)[0], '[desktop-e2e-inspector] disconnected')
      await assert.rejects(
        inspectRunningApp(
          port,
          child.pid,
          '(() => { const value = { owned: true }; globalThis.ownedResult = new WeakRef(value); return value })()',
          () => {}
        ),
        /injected cleanup transport failure/
      )
    } finally {
      globalThis.WebSocket = originalWebSocket
    }
    assert.equal(
      await inspectRunningApp(
        port,
        child.pid,
        '(() => { global.gc(); return globalThis.ownedResult.deref() === undefined })()',
        () => {}
      ),
      true
    )
  })
})

test('disconnecting a host rejects its pending assertion and releases the driver command', async () => {
  await withCollectableInspector(async (port, child) => {
    const events = []
    await assert.rejects(
      inspectRunningApp(port, child.pid, 'new Promise(() => {})', (...event) => {
        events.push(event)
        if (event[0] === '[desktop-e2e-inspector] command' && event[1] === 'Runtime.awaitPromise')
          setImmediate(() => child.kill('SIGKILL'))
      }),
      /Inspector disconnected during command: Runtime.awaitPromise/
    )
    assert.ok(events.some(event => event[0] === '[desktop-e2e-inspector] disconnected'))
  })
})

for (const moduleType of ['cjs', 'mjs']) {
  test(`initializes and disconnects before returning for ${moduleType} entry`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-inspector-entry-'))
    const entry = join(directory, `entry.${moduleType}`)
    await writeFile(entry, 'console.log(globalThis.testSetup)')
    const child = spawn(process.execPath, ['--inspect-brk=127.0.0.1:0', entry], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', chunk => {
      output += chunk
    })
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(20_000) })
    const diagnostics = []
    try {
      await inspectBeforeStart(
        child,
        'globalThis.testSetup = "installed before entry"',
        (...details) => diagnostics.push(details)
      )
      assert.ok(
        diagnostics.some(details => details[0] === '[desktop-e2e-inspector] disconnected'),
        'Setup must release its inspector connection before returning'
      )
      assert.deepEqual(await exited, [0, null])
      assert.equal(output.trim(), 'installed before entry')
      assert.ok(
        diagnostics.some(
          details =>
            details[0] === '[desktop-e2e-inspector] response' &&
            details[1] === 'Debugger.disable' &&
            details[2] === 'ok'
        ),
        'The application must start with the driver-owned debugger disabled'
      )
    } finally {
      child.kill()
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('reports a child that exits before the inspector is available', async () => {
  const child = spawn(process.execPath, ['--eval', 'process.exit(17)'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(20_000) })
  try {
    await assert.rejects(
      inspectBeforeStart(child, 'globalThis.testSetup = true'),
      /The isolated app exited before its inspector started/
    )
    assert.deepEqual(await exited, [17, null])
  } finally {
    child.kill()
  }
})
