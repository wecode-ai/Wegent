import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { WorkbenchPluginManager } from './workbench-plugin-manager.js'

const temporaryRoots: string[] = []
const managers: WorkbenchPluginManager[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.shutdown()))
  const { rm } = await import('node:fs/promises')
  await Promise.all(
    temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true }))
  )
})

describe('WorkbenchPluginManager', () => {
  test('inspects integrity, authorizes declared capabilities, and serves JSON-RPC', async () => {
    const searchRoot = await temporaryDirectory('wework-plugin-search-')
    const pluginRoot = join(searchRoot, 'fixture')
    await mkdir(join(pluginRoot, '.wework-plugin'), { recursive: true })
    const sidecarPath = join(pluginRoot, 'sidecar.mjs')
    const sidecar = `#!/usr/bin/env node
import { createInterface } from 'node:readline'
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  const request = JSON.parse(line)
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: request.id,
    result: { method: request.method, params: request.params },
  }) + '\\n')
}
`
    await writeFile(sidecarPath, sidecar)
    await chmod(sidecarPath, 0o755)
    await writeFile(
      join(pluginRoot, '.wework-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'fixture',
        apiVersion: '1',
        required: false,
        pinnedToClientVersion: false,
        desktop: {
          command: 'sidecar.mjs',
          args: [],
          sha256: sha256(sidecar),
          capabilities: ['fixture.read'],
        },
      })
    )
    const manager = new WorkbenchPluginManager([searchRoot])
    managers.push(manager)
    const canonicalPluginRoot = await realpath(pluginRoot)
    const canonicalSidecarPath = await realpath(sidecarPath)

    await expect(manager.list()).resolves.toMatchObject([
      {
        root: canonicalPluginRoot,
        manifest: { name: 'fixture' },
        desktopPath: canonicalSidecarPath,
      },
    ])
    await expect(manager.authorizeCapability(pluginRoot, 'fixture.read')).resolves.toBe(true)
    await expect(manager.authorizeCapability(pluginRoot, 'fixture.write')).resolves.toBe(false)
    await manager.start('fixture', pluginRoot)
    await expect(
      manager.request('fixture', 'fixture.read', 'fixture/get', { id: 7 })
    ).resolves.toEqual({ method: 'fixture/get', params: { id: 7 } })
    await expect(manager.request('fixture', 'fixture.write', 'fixture/set', {})).rejects.toThrow(
      "is not authorized for capability 'fixture.write'"
    )
    await expect(manager.stop('fixture')).resolves.toBeUndefined()
  })

  test('rejects a sidecar whose digest does not match the manifest', async () => {
    const pluginRoot = await temporaryDirectory('wework-plugin-invalid-')
    await mkdir(join(pluginRoot, '.wework-plugin'), { recursive: true })
    await writeFile(join(pluginRoot, 'sidecar.mjs'), '#!/usr/bin/env node\n')
    await writeFile(
      join(pluginRoot, '.wework-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'invalid',
        apiVersion: '1',
        desktop: {
          command: 'sidecar.mjs',
          sha256: '0'.repeat(64),
          capabilities: [],
        },
      })
    )
    const manager = new WorkbenchPluginManager([])
    managers.push(manager)

    await expect(manager.inspect(pluginRoot)).rejects.toThrow('desktop SHA-256 mismatch')
  })
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.push(path)
  return path
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}
