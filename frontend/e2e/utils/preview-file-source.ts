// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveStatic } from 'next/dist/server/serve-static'

let source: Promise<{ server: Server; directory: string; port: number }> | undefined

function servePreviewFile(directory: string, request: IncomingMessage, response: ServerResponse) {
  // Next's file server owns HEAD, Range/206/416 and disk reads, including 404s.
  response.setHeader('Access-Control-Allow-Origin', '*')
  // Cover and dialog renderers must both read from the origin; a cached cover
  // must not make the dialog's PDF.js Range assertion vacuous.
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader(
    'Access-Control-Expose-Headers',
    'Accept-Ranges, Content-Range, Content-Length'
  )
  response.setHeader('Access-Control-Allow-Headers', 'Range')
  response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
  if (request.method === 'OPTIONS') {
    response.writeHead(204).end()
    return
  }
  const pathname = new URL(request.url || '/', 'https://localhost').pathname
  // Only document fixtures are public; never serve the TLS key or certificate.
  if (!/^\/(preview\.pdf|preview\.docx|unavailable\.txt)$/.test(pathname)) {
    response.writeHead(404).end()
    return
  }
  void serveStatic(request, response, pathname, {
    root: directory,
    cacheControl: false,
  }).catch((error: { statusCode?: number }) => {
    response.writeHead(error.statusCode || 500).end()
  })
}

async function startSource() {
  const directory = await mkdtemp(join(tmpdir(), 'wegent-preview-files-'))
  try {
    const { writePreviewFiles } = await import('./preview-file-fixtures')
    // Ephemeral test-only identity; no private key is stored in the repository.
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-keyout',
        join(directory, 'key.pem'),
        '-out',
        join(directory, 'cert.pem'),
      ],
      { stdio: 'ignore' }
    )
    await writePreviewFiles(directory)
    const server = createServer(
      {
        key: await readFile(join(directory, 'key.pem')),
        cert: await readFile(join(directory, 'cert.pem')),
      },
      (request, response) => servePreviewFile(directory, request, response)
    )
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '0.0.0.0', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing preview source port')
    return { server, directory, port: address.port }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export async function closePreviewFileSource(): Promise<void> {
  if (!source) return
  const pending = source
  source = undefined
  const current = await pending
  current.server.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    current.server.close(error => (error ? reject(error) : resolve()))
  )
  await rm(current.directory, { recursive: true, force: true })
}

/** Lazy HTTPS listener inside the existing provider process, shared by its suite. */
export async function handlePreviewFileSource(request: IncomingMessage, response: ServerResponse) {
  if (request.url !== '/preview-file-source') return false
  if (request.method === 'DELETE') {
    await closePreviewFileSource()
    response.writeHead(204).end()
  } else if (request.method === 'GET') {
    source ||= startSource().catch(error => {
      source = undefined
      throw error
    })
    const { port } = await source
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ port }))
  } else {
    response.writeHead(405).end()
  }
  return true
}
