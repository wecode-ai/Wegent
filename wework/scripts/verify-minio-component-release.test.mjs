import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

import { desktopComponentIds, sharedDesktopComponentIds } from './lib/desktop-component-ids.mjs'

const scriptsRoot = dirname(fileURLToPath(import.meta.url))
const verifierPath = resolve(scriptsRoot, 'verify-minio-component-release.mjs')

describe('MinIO component release verification', () => {
  test('accepts the complete desktop component manifest', async () => {
    const result = await runVerifier(desktopComponentIds)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Verified MinIO component release: 1.2.3 stable macos-arm64')
  })

  test('rejects a manifest with a missing desktop component', async () => {
    const result = await runVerifier(desktopComponentIds.slice(0, -1))

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Published component manifest is incompatible')
  })

  test('rejects a manifest with an unknown desktop component', async () => {
    const result = await runVerifier([...desktopComponentIds, 'unknown'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Published component manifest is incompatible')
  })

  test('rejects a shared component stored under the app release prefix', async () => {
    const result = await runVerifier(desktopComponentIds, {
      misroutedComponent: 'coreDsh',
    })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      'Published component URL is outside its MinIO storage prefix: coreDsh'
    )
  })

  test('rejects an app-specific component stored under the shared prefix', async () => {
    const result = await runVerifier(desktopComponentIds, {
      misroutedComponent: 'executor',
    })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      'Published component URL is outside its MinIO storage prefix: executor'
    )
  })
})

async function runVerifier(componentIds, options = {}) {
  const sharedComponentIds = new Set(sharedDesktopComponentIds)
  const archives = new Map(
    componentIds.map(id => [
      `/${sharedComponentIds.has(id) ? 'components' : 'releases'}/${id}.tar.gz`,
      Buffer.from(`archive-${id}`),
    ])
  )
  let manifest
  const server = createServer((request, response) => {
    if (request.url === '/releases/components-stable-macos-arm64.json') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(manifest))
      return
    }

    const archive = archives.get(request.url)
    if (!archive) {
      response.statusCode = 404
      response.end()
      return
    }
    response.setHeader('content-length', archive.length)
    response.end(request.method === 'HEAD' ? undefined : archive)
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })

  try {
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Verifier test server did not expose a TCP address')
    }
    const baseUrl = `http://127.0.0.1:${address.port}/releases`
    const sharedBaseUrl = `http://127.0.0.1:${address.port}/components`
    manifest = {
      schemaVersion: 1,
      appVersion: '1.2.3',
      channel: 'stable',
      platform: 'macos',
      arch: 'arm64',
      components: Object.fromEntries(
        componentIds.map(id => {
          const expectedPrefix = sharedComponentIds.has(id) ? 'components' : 'releases'
          const actualPrefix =
            options.misroutedComponent === id
              ? expectedPrefix === 'components'
                ? 'releases'
                : 'components'
              : expectedPrefix
          const archive = archives.get(`/${expectedPrefix}/${id}.tar.gz`)
          return [
            id,
            {
              downloadUrl: `http://127.0.0.1:${address.port}/${actualPrefix}/${id}.tar.gz`,
              archiveBytes: archive.length,
              archiveSha256: 'a'.repeat(64),
            },
          ]
        })
      ),
    }

    return await runProcess(process.execPath, [
      verifierPath,
      baseUrl,
      sharedBaseUrl,
      '1.2.3',
      'stable',
      'macos',
      'arm64',
    ])
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      server.close(error => (error ? rejectClose(error) : resolveClose()))
    })
  }
}

function runProcess(command, args) {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, {
      cwd: resolve(scriptsRoot, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.once('error', rejectProcess)
    child.once('exit', code => {
      resolveProcess({ code, stdout, stderr })
    })
  })
}
