import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { createServer, get } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { streamTerminalEvents } from './sse-events.js'
import { TerminalRuntime } from './terminal-runtime.js'

class FakePty {
  #events = new EventEmitter()
  killed = false
  resized = null
  written = []

  onData(listener) {
    this.#events.on('data', listener)
    return { dispose: () => this.#events.off('data', listener) }
  }

  onExit(listener) {
    this.#events.on('exit', listener)
    return { dispose: () => this.#events.off('exit', listener) }
  }

  write(data) {
    this.written.push(data)
  }

  resize(cols, rows) {
    this.resized = { cols, rows }
  }

  kill() {
    this.killed = true
  }

  emitData(data) {
    this.#events.emit('data', data)
  }

  emitExit(exitCode = 0) {
    this.#events.emit('exit', { exitCode, signal: 0 })
  }
}

test('owns PTY sessions, snapshots, events and cleanup inside Core DSH', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-terminal-runtime-'))
  const pty = new FakePty()
  const spawns = []
  const runtime = new TerminalRuntime({
    platform: 'darwin',
    environment: { HOME: directory, SHELL: '/bin/zsh' },
    spawn(executable, args, options) {
      spawns.push({ executable, args, options })
      return pty
    },
  })
  const events = []
  const unlisten = runtime.listen(event => events.push(event))

  try {
    const started = await runtime.request('terminal.start', {
      session_id: 'terminal-fixture',
      cwd: directory,
      rows: 30,
      cols: 100,
      env: { WEWORK_TERMINAL_TEST: '1' },
    })
    assert.deepEqual(started, { session_id: 'terminal-fixture' })
    assert.equal(spawns[0].executable, '/bin/zsh')
    assert.deepEqual(spawns[0].args, ['-l'])
    assert.equal(spawns[0].options.cwd, directory)
    assert.equal(spawns[0].options.env.WEWORK_TERMINAL_TEST, '1')

    pty.emitData('terminal-ready\r\n')
    assert.deepEqual(
      await runtime.request('terminal.snapshot', {
        session_id: 'terminal-fixture',
      }),
      {
        session_id: 'terminal-fixture',
        sequence: 1,
        data: 'terminal-ready\r\n',
      }
    )
    assert.equal(events[0].event, 'terminal.output')
    assert.equal(events[0].payload.sequence, 1)

    await runtime.request('terminal.input', {
      session_id: 'terminal-fixture',
      data: 'pwd\r',
    })
    await runtime.request('terminal.resize', {
      session_id: 'terminal-fixture',
      rows: 40,
      cols: 120,
    })
    assert.deepEqual(pty.written, ['pwd\r'])
    assert.deepEqual(pty.resized, { cols: 120, rows: 40 })

    pty.emitExit(7)
    assert.equal(events[1].event, 'terminal.exit')
    assert.equal(events[1].payload.exit_code, 7)
    await assert.rejects(
      runtime.request('terminal.input', {
        session_id: 'terminal-fixture',
        data: 'ignored',
      }),
      error => error.code === 'session_exited'
    )

    await runtime.request('terminal.close', { session_id: 'terminal-fixture' })
    assert.equal(runtime.describe().activeSessions, 0)
  } finally {
    unlisten()
    runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects unsafe session ids, relative cwd and invalid dimensions', async () => {
  const runtime = new TerminalRuntime({
    spawn() {
      throw new Error('must not spawn')
    },
  })

  await assert.rejects(
    runtime.request('terminal.start', { session_id: '../escape', cwd: '/tmp' }),
    error => error.code === 'invalid_params'
  )
  await assert.rejects(
    runtime.request('terminal.start', { session_id: 'safe', cwd: 'relative' }),
    error => error.code === 'invalid_params'
  )
  await assert.rejects(
    runtime.request('terminal.start', { session_id: 'safe', cwd: '/tmp', rows: 0 }),
    error => error.code === 'invalid_params'
  )
})

test('starts an explicit Harness executable with arguments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-harness-runtime-'))
  const pty = new FakePty()
  const spawns = []
  const runtime = new TerminalRuntime({
    environment: { HOME: directory },
    spawn(executable, args, options) {
      spawns.push({ executable, args, options })
      return pty
    },
  })

  try {
    await runtime.request('terminal.start', {
      session_id: 'local-harness-1',
      cwd: directory,
      executable: '/usr/bin/example-harness',
      args: ['--model', 'fixture'],
      env: { HARNESS_FIXTURE: '1' },
    })

    assert.equal(spawns[0].executable, '/usr/bin/example-harness')
    assert.deepEqual(spawns[0].args, ['--model', 'fixture'])
    assert.equal(spawns[0].options.env.HARNESS_FIXTURE, '1')
  } finally {
    runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('stops SSE delivery when the browser disconnects without writing after end', () => {
  const request = new EventEmitter()
  request.method = 'GET'
  request.url = '/wework/terminal/v1/events?after=0'
  request.headers = {}
  request.socket = { remoteAddress: '127.0.0.1' }
  const response = new EventEmitter()
  response.destroyed = false
  response.writableEnded = false
  response.writeHead = () => {}
  response.writes = []
  response.write = value => {
    response.writes.push(value)
    return true
  }
  let listener = null
  let registeredListener = null
  let disposed = false
  const runtime = {
    replay: () => [],
    listen(nextListener) {
      listener = nextListener
      registeredListener = nextListener
      return () => {
        disposed = true
        listener = null
      }
    },
  }

  streamTerminalEvents(request, response, runtime, 0)
  assert.equal(response.writes.length, 1)
  response.emit('close')
  assert.equal(disposed, true)

  response.writableEnded = true
  registeredListener({ sequence: 1, event: 'terminal.output', payload: {} })
  assert.equal(response.writes.length, 1)
})

test(
  'keeps SSE delivery after the HTTP request completes until the response disconnects',
  { timeout: 5000 },
  async t => {
    let listener
    let disposed = false
    let completeRequest
    let responseClosed
    const lifecycle = []
    const requestCompleted = new Promise(resolve => {
      completeRequest = resolve
    })
    const responseCompleted = new Promise(resolve => {
      responseClosed = resolve
    })
    const server = createServer((request, response) => {
      streamTerminalEvents(
        request,
        response,
        {
          replay: () => [],
          listen(next) {
            listener = next
            return () => {
              disposed = true
            }
          },
        },
        0,
        status => lifecycle.push(status)
      )
      request.once('close', () => completeRequest(request.complete))
      response.once('close', responseClosed)
      request.resume()
    })
    let client
    t.after(async () => {
      client?.destroy()
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    client = await new Promise((resolve, reject) => {
      get(`http://127.0.0.1:${server.address().port}/events`, resolve).once('error', reject)
    })
    const chunks = []
    client.on('data', chunk => chunks.push(chunk.toString()))
    assert.equal(await requestCompleted, true)
    assert.equal(disposed, false)
    assert.deepEqual(lifecycle, ['opened'])
    await once(client, 'data')
    const delivered = once(client, 'data')
    listener({ sequence: 1, event: 'terminal.output', payload: { data: 'live-output' } })
    await delivered
    assert.match(chunks.join(''), /live-output/)
    client.destroy()
    await responseCompleted
    assert.equal(disposed, true)
    assert.deepEqual(lifecycle, ['opened', 'closed'])
  }
)

test('terminal diagnostics retain byte counts and original input failures without private data', async () => {
  const pty = new FakePty()
  const diagnostics = []
  const runtime = new TerminalRuntime({
    spawn: () => pty,
    diagnostic: event => diagnostics.push(event),
  })
  const sessionId = 'private-session-secret'
  try {
    await runtime.request('terminal.start', { session_id: sessionId, cwd: process.cwd() })
    pty.emitData('private-output-secret')
    await runtime.request('terminal.snapshot', { session_id: sessionId })
    await runtime.request('terminal.input', { session_id: sessionId, data: 'private-input-secret' })
    const failure = new Error('private-failure-secret')
    pty.write = () => {
      throw failure
    }
    await assert.rejects(
      runtime.request('terminal.input', { session_id: sessionId, data: 'private-input-secret' }),
      error => error === failure
    )
    assert.deepEqual(
      diagnostics.map(event => event.phase),
      ['output', 'snapshot', 'input-started', 'input-completed', 'input-started', 'input-failed']
    )
    assert.equal(diagnostics[0].bytes, Buffer.byteLength('private-output-secret'))
    assert.equal(diagnostics[1].sequence, 1)
    assert.ok(diagnostics.every(event => event.sessionSequence === 1))
    assert.doesNotMatch(JSON.stringify(diagnostics), /private|secret|session_id|cwd|data/)
  } finally {
    runtime.dispose()
  }
})

for (const [target, event] of [
  ['request', 'aborted'],
  ['response', 'finish'],
  ['response', 'error'],
]) {
  test(`cleans the terminal SSE subscription once on ${target} ${event}`, () => {
    const request = new EventEmitter()
    const response = new EventEmitter()
    Object.assign(response, { writeHead() {}, write() {} })
    let disposalCount = 0
    const lifecycle = []
    streamTerminalEvents(
      request,
      response,
      {
        replay: () => [],
        listen: () => () => {
          disposalCount++
        },
      },
      0,
      status => lifecycle.push(status)
    )
    ;(target === 'request' ? request : response).emit(event)
    response.emit('close')
    assert.equal(disposalCount, 1)
    assert.deepEqual(lifecycle, ['opened', 'closed'])
  })
}
