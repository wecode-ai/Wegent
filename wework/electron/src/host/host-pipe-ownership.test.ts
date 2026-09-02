import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, test } from 'vitest'
import { HostCapabilityRouter } from './capability-router.js'
import { HostPipeServer } from './host-pipe.js'

const children: ChildProcessWithoutNullStreams[] = []
const servers: HostPipeServer[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop()
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL')
  }
})

// The child sends a versioned hello on fd 4 whenever it reads a "ping" line on fd 3
// (the host's response channel), and prints "pong" to stdout for every host reply.
function spawnResponder(server: HostPipeServer): ChildProcessWithoutNullStreams {
  const script = `
    const fs = require('node:fs')
    const readline = require('node:readline')
    const out = fs.createWriteStream(null, { fd: 4, autoClose: false })
    const hello = JSON.stringify({
      type: 'hello',
      protocolVersion: 1,
      token: process.env.HOST_TOKEN,
      principal: '@wegent/dsh-app-wework',
    })
    readline
      .createInterface({ input: fs.createReadStream(null, { fd: 3, autoClose: false }) })
      .on('line', line => {
        if (line === 'ping') out.write(hello + '\\n')
        else process.stdout.write('pong\\n')
      })
    setInterval(() => {}, 1000)
  `
  const child = spawn(process.execPath, ['-e', script], {
    env: { ...process.env, HOST_TOKEN: server.environment().WEWORK_ELECTRON_HOST_TOKEN },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams
  child.stdout.setEncoding('utf8')
  children.push(child)
  return child
}

function pongReader(child: ChildProcessWithoutNullStreams): () => number {
  let buffer = ''
  child.stdout.on('data', chunk => {
    buffer += String(chunk)
  })
  return () => (buffer.match(/pong/g) ?? []).length
}

async function waitForPongIncrease(
  pongs: () => number,
  before: number,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pongs() > before) return true
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return false
}

describe('HostPipeServer session ownership', () => {
  test('M3-D: detaches only the host session owned by the given child', async () => {
    const router = new HostCapabilityRouter()
    router.grant('@wegent/dsh-app-wework', ['window.getState'])
    router.register('window.getState', async () => ({ maximized: false }))
    const server = new HostPipeServer(router)
    servers.push(server)
    const childA = spawnResponder(server)
    const childB = spawnResponder(server)

    server.attach(childA)
    server.attach(childB)
    const pongs = pongReader(childB)

    // A stale owner's cleanup must not detach the current session (B).
    server.detachChild(childA)
    childB.stdio[3].write('ping\n')
    expect(await waitForPongIncrease(pongs, 0, 2_000)).toBe(true)
    const countBeforeDetach = pongs()

    // The owning child still detaches its own session.
    server.detachChild(childB)
    childB.stdio[3].write('ping\n')
    expect(await waitForPongIncrease(pongs, countBeforeDetach, 300)).toBe(false)
  })
})
