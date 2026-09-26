import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'

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

export async function reservePort(registryDir = process.env.WEWORK_E2E_PORT_REGISTRY_DIR) {
  while (true) {
    const server = createServer()
    await new Promise((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolvePromise)
    })
    const address = server.address()
    assert.ok(address && typeof address !== 'string', 'Unable to reserve an E2E port')
    const claimed = await claimPort(registryDir, address.port)
    await new Promise(resolvePromise => server.close(resolvePromise))
    if (claimed) return address.port
  }
}
