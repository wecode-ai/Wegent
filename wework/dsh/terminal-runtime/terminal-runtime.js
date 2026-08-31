import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { stat } from 'node:fs/promises'

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const MAX_DIMENSION = 1000
const MAX_ENVIRONMENT_ENTRIES = 256
const MAX_EVENT_HISTORY = 1024
const MAX_INPUT_BYTES = 1024 * 1024
const MAX_SESSIONS = 64
const MAX_SNAPSHOT_BYTES = 1024 * 1024
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export class TerminalRuntimeError extends Error {
  constructor(code, message, status = 500) {
    super(message)
    this.name = 'TerminalRuntimeError'
    this.code = code
    this.status = status
  }
}

export class TerminalRuntime {
  #environment
  #events = []
  #listeners = new Set()
  #nextEventSequence = 1
  #platform
  #sessions = new Map()
  #spawn

  constructor({ spawn, environment = process.env, platform = process.platform }) {
    if (typeof spawn !== 'function') {
      throw new TypeError('Terminal runtime requires a PTY spawn function')
    }
    this.#spawn = spawn
    this.#environment = environment
    this.#platform = platform
  }

  describe() {
    return {
      protocolVersion: 1,
      runtime: 'core-dsh',
      capabilities: [
        'terminal.start',
        'terminal.snapshot',
        'terminal.input',
        'terminal.resize',
        'terminal.close',
        'terminal.events',
      ],
      activeSessions: [...this.#sessions.values()].filter(session => session.pty).length,
    }
  }

  async request(method, params) {
    if (!isRecord(params)) {
      throw new TerminalRuntimeError('invalid_params', 'Terminal params must be an object', 400)
    }
    switch (method) {
      case 'terminal.start':
        return this.#start(params)
      case 'terminal.snapshot':
        return this.#snapshot(params)
      case 'terminal.input':
        return this.#input(params)
      case 'terminal.resize':
        return this.#resize(params)
      case 'terminal.close':
        return this.#close(params)
      default:
        throw new TerminalRuntimeError(
          'unsupported_method',
          `Unsupported terminal method: ${method}`,
          404
        )
    }
  }

  replay(after = 0) {
    return this.#events.filter(event => event.sequence > after)
  }

  listen(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  dispose() {
    for (const session of this.#sessions.values()) {
      this.#kill(session)
    }
    this.#sessions.clear()
    this.#listeners.clear()
    this.#events = []
  }

  async #start(params) {
    const sessionId = requiredSessionId(params)
    if (this.#sessions.has(sessionId)) {
      throw new TerminalRuntimeError(
        'session_exists',
        `Terminal session already exists: ${sessionId}`,
        409
      )
    }
    const activeSessions = [...this.#sessions.values()].filter(session => session.pty).length
    if (activeSessions >= MAX_SESSIONS) {
      throw new TerminalRuntimeError(
        'session_limit_reached',
        `Terminal session limit reached (${MAX_SESSIONS})`,
        429
      )
    }
    const cwd = await terminalCwd(params.cwd)
    const cols = terminalDimension(params.cols, DEFAULT_COLS, 'cols')
    const rows = terminalDimension(params.rows, DEFAULT_ROWS, 'rows')
    const environment = terminalEnvironment(this.#environment, params.env)
    const command = terminalCommand(params, this.#platform, environment)
    let pty
    try {
      pty = this.#spawn(command.executable, command.args, {
        name: 'xterm-256color',
        cwd,
        cols,
        rows,
        env: environment,
      })
    } catch (error) {
      throw new TerminalRuntimeError(
        'spawn_failed',
        error instanceof Error ? error.message : String(error)
      )
    }
    const session = {
      id: sessionId,
      pty,
      sequence: 0,
      snapshot: '',
      dataSubscription: null,
      exitSubscription: null,
    }
    this.#sessions.set(sessionId, session)
    session.dataSubscription = pty.onData(data => this.#handleOutput(session, data))
    session.exitSubscription = pty.onExit(event => this.#handleExit(session, event))
    return { session_id: sessionId }
  }

  #snapshot(params) {
    const session = this.#requiredSession(requiredSessionId(params))
    return {
      session_id: session.id,
      sequence: session.sequence,
      data: session.snapshot,
    }
  }

  #input(params) {
    const session = this.#requiredActiveSession(requiredSessionId(params))
    if (typeof params.data !== 'string') {
      throw new TerminalRuntimeError('invalid_params', 'Terminal input data is required', 400)
    }
    if (Buffer.byteLength(params.data) > MAX_INPUT_BYTES) {
      throw new TerminalRuntimeError('input_too_large', 'Terminal input exceeds size limit', 413)
    }
    session.pty.write(params.data)
    return { session_id: session.id }
  }

  #resize(params) {
    const session = this.#requiredActiveSession(requiredSessionId(params))
    const cols = terminalDimension(params.cols, null, 'cols')
    const rows = terminalDimension(params.rows, null, 'rows')
    session.pty.resize(cols, rows)
    return { session_id: session.id }
  }

  #close(params) {
    const sessionId = requiredSessionId(params)
    const session = this.#requiredSession(sessionId)
    this.#sessions.delete(sessionId)
    this.#kill(session)
    return { session_id: sessionId }
  }

  #requiredSession(sessionId) {
    const session = this.#sessions.get(sessionId)
    if (!session) {
      throw new TerminalRuntimeError(
        'session_not_found',
        `Terminal session was not found: ${sessionId}`,
        404
      )
    }
    return session
  }

  #requiredActiveSession(sessionId) {
    const session = this.#requiredSession(sessionId)
    if (!session.pty) {
      throw new TerminalRuntimeError(
        'session_exited',
        `Terminal session has exited: ${sessionId}`,
        409
      )
    }
    return session
  }

  #handleOutput(session, data) {
    if (typeof data !== 'string' || !data) return
    session.sequence += 1
    session.snapshot = trimUtf8Tail(session.snapshot + data, MAX_SNAPSHOT_BYTES)
    this.#emit('terminal.output', {
      session_id: session.id,
      sequence: session.sequence,
      data,
    })
  }

  #handleExit(session, event) {
    if (!this.#sessions.has(session.id) || !session.pty) return
    session.pty = null
    disposeSubscription(session.dataSubscription)
    disposeSubscription(session.exitSubscription)
    session.dataSubscription = null
    session.exitSubscription = null
    this.#emit('terminal.exit', {
      session_id: session.id,
      exit_code: Number.isInteger(event?.exitCode) ? event.exitCode : null,
      signal: Number.isInteger(event?.signal) ? event.signal : null,
    })
  }

  #emit(name, payload) {
    const event = {
      protocolVersion: 1,
      sequence: this.#nextEventSequence++,
      emittedAt: new Date().toISOString(),
      event: name,
      payload,
    }
    this.#events.push(event)
    if (this.#events.length > MAX_EVENT_HISTORY) {
      this.#events.splice(0, this.#events.length - MAX_EVENT_HISTORY)
    }
    for (const listener of this.#listeners) listener(event)
  }

  #kill(session) {
    disposeSubscription(session.dataSubscription)
    disposeSubscription(session.exitSubscription)
    session.dataSubscription = null
    session.exitSubscription = null
    const pty = session.pty
    session.pty = null
    if (!pty) return
    try {
      pty.kill()
    } catch {
      // The child may have exited between the active check and cleanup.
    }
  }
}

function requiredSessionId(params) {
  const sessionId = typeof params.session_id === 'string' ? params.session_id.trim() : ''
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new TerminalRuntimeError(
      'invalid_params',
      'session_id must contain 1-128 safe characters',
      400
    )
  }
  return sessionId
}

async function terminalCwd(value) {
  const cwd = typeof value === 'string' && value.trim() ? value.trim() : homedir()
  if (!isAbsolute(cwd)) {
    throw new TerminalRuntimeError('invalid_params', 'Terminal cwd must be absolute', 400)
  }
  let metadata
  try {
    metadata = await stat(cwd)
  } catch {
    throw new TerminalRuntimeError('cwd_not_found', `Terminal cwd does not exist: ${cwd}`, 404)
  }
  if (!metadata.isDirectory()) {
    throw new TerminalRuntimeError(
      'cwd_not_directory',
      `Terminal cwd is not a directory: ${cwd}`,
      400
    )
  }
  return cwd
}

function terminalDimension(value, fallback, field) {
  if (value == null && fallback != null) return fallback
  if (!Number.isInteger(value) || value < 1 || value > MAX_DIMENSION) {
    throw new TerminalRuntimeError(
      'invalid_params',
      `${field} must be an integer between 1 and ${MAX_DIMENSION}`,
      400
    )
  }
  return value
}

function terminalEnvironment(base, overrides) {
  if (overrides != null && !isRecord(overrides)) {
    throw new TerminalRuntimeError('invalid_params', 'env must be an object', 400)
  }
  const entries = Object.entries(overrides ?? {})
  if (entries.length > MAX_ENVIRONMENT_ENTRIES) {
    throw new TerminalRuntimeError(
      'invalid_params',
      `env may contain at most ${MAX_ENVIRONMENT_ENTRIES} entries`,
      400
    )
  }
  const environment = { ...base }
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string') {
      throw new TerminalRuntimeError(
        'invalid_params',
        'env keys and values must be valid strings',
        400
      )
    }
    environment[key] = value
  }
  environment.TERM = environment.TERM || 'xterm-256color'
  return environment
}

function terminalShell(platform, environment) {
  if (platform === 'win32') {
    const executable = environment.COMSPEC?.trim() || 'pwsh.exe'
    return {
      executable,
      args: /pwsh|powershell/i.test(executable) ? ['-NoLogo'] : [],
    }
  }
  const configured = environment.SHELL?.trim()
  const executable =
    configured && isAbsolute(configured)
      ? configured
      : platform === 'darwin'
        ? '/bin/zsh'
        : '/bin/bash'
  return { executable, args: ['-l'] }
}

function terminalCommand(params, platform, environment) {
  const executable =
    typeof params.executable === 'string' && params.executable.trim()
      ? params.executable.trim()
      : null
  if (!executable) return terminalShell(platform, environment)
  if (!isAbsolute(executable)) {
    throw new TerminalRuntimeError(
      'invalid_params',
      'Terminal executable must be an absolute path',
      400
    )
  }
  if (params.args != null && !Array.isArray(params.args)) {
    throw new TerminalRuntimeError('invalid_params', 'Terminal args must be an array', 400)
  }
  const args = (params.args ?? []).map(value => {
    if (typeof value !== 'string' || value.includes('\0')) {
      throw new TerminalRuntimeError(
        'invalid_params',
        'Terminal args must contain valid strings',
        400
      )
    }
    return value
  })
  return { executable, args }
}

function trimUtf8Tail(value, maxBytes) {
  const buffer = Buffer.from(value)
  if (buffer.byteLength <= maxBytes) return value
  return buffer
    .subarray(buffer.byteLength - maxBytes)
    .toString('utf8')
    .replace(/^\uFFFD/, '')
}

function disposeSubscription(subscription) {
  try {
    subscription?.dispose?.()
  } catch {
    // Subscription disposal is best-effort during process teardown.
  }
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
