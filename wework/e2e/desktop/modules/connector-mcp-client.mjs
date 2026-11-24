import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { stopProcess } from '../process-lifecycle.mjs'

export function withConnectorMcp(options, verify) {
  return withExecutorMcp(
    {
      ...options,
      args: ['connector-mcp-server'],
      serverName: 'wegent_apps',
    },
    verify
  )
}

export async function withExecutorMcp(
  { binary, args, environment, serverName, timeoutMs = 10_000 },
  verify
) {
  assert.ok(typeof binary === 'string' && binary, 'MCP requires an Executor binary')
  assert.ok(environment && typeof environment === 'object', 'MCP requires an isolated environment')
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, 'MCP requires a positive timeout')
  const child = spawn(binary, args, {
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const pending = new Map()
  let nextId = 0
  let failure
  let closing = false
  const fail = error => {
    failure ??= error
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(failure)
    }
    pending.clear()
  }
  child.once('error', () => fail(new Error('Executor MCP failed to start')))
  child.once('exit', () => fail(new Error('Executor MCP exited')))
  child.stdin.on('error', () => fail(new Error('Executor MCP input failed')))
  child.stdout.on('error', () => fail(new Error('Executor MCP output failed')))
  child.stderr.on('error', () => fail(new Error('Executor MCP diagnostics stream failed')))
  child.stderr.resume()
  const input = createInterface({ input: child.stdout })
  input.on('close', () => {
    if (!closing) fail(new Error('Executor MCP output closed'))
  })
  input.on('line', line => {
    let message
    try {
      message = JSON.parse(line)
      if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
        throw new Error('Invalid message')
      }
    } catch {
      fail(new Error('Executor MCP returned invalid JSON-RPC'))
      return
    }
    const item = pending.get(message.id)
    if (!item) return
    if (!message.error && !Object.hasOwn(message, 'result')) {
      fail(new Error('Executor MCP response did not contain a result'))
      return
    }
    clearTimeout(item.timer)
    pending.delete(message.id)
    if (message.error) item.reject(new Error('Executor MCP JSON-RPC request failed'))
    else item.resolve(message.result)
  })
  const assertRunning = () => {
    if (failure) throw failure
    assert.ok(
      !closing &&
        child.pid &&
        child.exitCode === null &&
        child.signalCode === null &&
        !child.killed,
      'Executor MCP is not running'
    )
  }
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      try {
        assertRunning()
        const id = ++nextId
        const encoded = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
        const timer = setTimeout(() => fail(new Error('Executor MCP request timed out')), timeoutMs)
        pending.set(id, { resolve, reject, timer })
        child.stdin.write(encoded, error => {
          if (error) fail(new Error('Executor MCP input failed'))
        })
      } catch {
        fail(new Error('Executor MCP request could not be sent'))
        reject(failure)
      }
    })

  try {
    const initialized = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'wework-desktop-e2e', version: '1' },
    })
    assert.ok(initialized?.serverInfo?.name === serverName, 'Unexpected Executor MCP server')
    assert.ok(initialized.protocolVersion === '2024-11-05', 'Unexpected Executor MCP protocol')
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      error => {
        if (error) fail(new Error('Executor MCP initialization failed'))
      }
    )
    const result = await verify({ request, pid: child.pid, assertRunning })
    assertRunning()
    return result
  } finally {
    closing = true
    fail(new Error('Executor MCP client closed'))
    try {
      if (!child.stdin.destroyed) child.stdin.end()
    } finally {
      try {
        if (child.pid) await stopProcess(child)
      } finally {
        input.close()
      }
    }
  }
}
