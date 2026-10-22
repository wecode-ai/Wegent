import assert from 'node:assert/strict'
import { randomInt } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'

// Fetch blocks these unprivileged ports even when TCP binding succeeds.
// https://fetch.spec.whatwg.org/#port-blocking
const FETCH_BLOCKED_SERVICE_PORTS = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
])

let linuxDynamicPortRange

async function kernelDynamicPortRange() {
  if (process.platform !== 'linux') return null
  // Services publish these ports before binding. Keep independent listen(0)
  // processes, including Core DSH, from claiming them during service startup.
  linuxDynamicPortRange ??= readFile('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').then(
    value => {
      const range = value.trim().split(/\s+/).map(Number)
      assert.ok(
        range.length === 2 &&
          range.every(Number.isInteger) &&
          range[0] > 1023 &&
          range[1] <= 65535 &&
          range[0] <= range[1],
        `Invalid kernel dynamic port range: ${value.trim()}`
      )
      return range
    }
  )
  return linuxDynamicPortRange
}

async function claimPort(registryDir, port) {
  if (!registryDir) return true
  try {
    await mkdir(join(registryDir, String(port)))
    return true
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  }
}

function* candidatePorts(dynamicRange) {
  if (!dynamicRange) {
    while (true) yield 0
  }
  const [first, last] = dynamicRange
  const lowerCount = first - 1024
  const count = lowerCount + 65535 - last
  assert.ok(count > 0, 'No E2E service ports available outside the kernel dynamic range')
  const start = randomInt(count)
  for (let index = 0; index < count; index += 1) {
    const offset = (start + index) % count
    yield offset < lowerCount ? 1024 + offset : last + 1 + offset - lowerCount
  }
}

export async function reservePort(
  registryDir = process.env.WEWORK_E2E_PORT_REGISTRY_DIR,
  { dynamicRange } = {}
) {
  const excludedRange = dynamicRange === undefined ? await kernelDynamicPortRange() : dynamicRange
  for (const port of candidatePorts(excludedRange)) {
    const server = createServer()
    try {
      await new Promise((resolvePromise, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', resolvePromise)
      })
      const address = server.address()
      assert.ok(address && typeof address !== 'string', 'Unable to reserve an E2E port')
      if (address.port < 1024 || FETCH_BLOCKED_SERVICE_PORTS.has(address.port)) continue
      if (await claimPort(registryDir, address.port)) return address.port
    } catch (error) {
      if (!excludedRange || error.code !== 'EADDRINUSE') throw error
    } finally {
      await new Promise(resolvePromise => server.close(resolvePromise))
    }
  }
  throw new Error('All E2E service ports outside the kernel dynamic range are occupied or claimed')
}
