// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

/** Serve the preview and forward the real frontend through the same origin. */
export async function createAppPreviewServer(frontendUrl: string, document: string) {
  let previewRequests = 0
  const upstream = new URL(frontendUrl)
  const requestUpstream = upstream.protocol === 'https:' ? httpsRequest : httpRequest
  const server = createServer((request, response) => {
    if (request.url === '/app-preview-fixture') {
      previewRequests += 1
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      response.end(document)
      return
    }
    // Forward actual pages, assets and APIs without replacing product responses.
    const forwarded = requestUpstream(
      new URL(request.url || '/', upstream),
      { method: request.method, headers: { ...request.headers, host: upstream.host } },
      upstreamResponse => {
        response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers)
        upstreamResponse.pipe(response)
      }
    )
    forwarded.on('error', error => {
      if (!response.headersSent) response.writeHead(502)
      response.end(error.message)
    })
    request.pipe(forwarded)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '0.0.0.0', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing preview fixture port')
  const host = process.env.E2E_TEST_CONTAINER_ADDRESS?.trim() || 'localhost'
  return {
    origin: `http://${host}:${address.port}`,
    previewRequests: () => previewRequests,
    async close() {
      const closed = new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
      server.closeAllConnections()
      await closed
    },
  }
}
