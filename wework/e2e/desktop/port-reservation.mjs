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

export async function reserveListeningPort(registryDir = process.env.WEWORK_E2E_PORT_REGISTRY_DIR) {
  while (true) {
    const server = createServer(socket => socket.destroy())
    await new Promise((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolvePromise)
    })
    const address = server.address()
    assert.ok(address && typeof address !== 'string', 'Unable to reserve an E2E port')
    let released
    const release = () =>
      (released ??= new Promise((resolvePromise, reject) => {
        server.close(error => (error ? reject(error) : resolvePromise()))
      }))
    let claimed
    try {
      claimed = await claimPort(registryDir, address.port)
    } catch (error) {
      await release()
      throw error
    }
    if (claimed) return { port: address.port, release }
    await release()
  }
}

export async function reservePort(registryDir = process.env.WEWORK_E2E_PORT_REGISTRY_DIR) {
  const reservation = await reserveListeningPort(registryDir)
  await reservation.release()
  return reservation.port
}
