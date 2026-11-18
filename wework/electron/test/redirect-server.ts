import { createServer, type Server } from 'node:http'

/** Exercise real fetch redirect handling without contacting an external service. */
export async function createRedirectServer() {
  const requests: Array<{ url?: string; authorization?: string; apiKey?: string }> = []
  const redirectedRequests: string[] = []
  const target = createServer((request, response) => {
    redirectedRequests.push(request.url ?? '')
    response.end('{}')
  })
  const targetUrl = await listen(target)
  const source = createServer((request, response) => {
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      apiKey: request.headers['x-api-key'] as string | undefined,
    })
    response.writeHead(307, { location: `${targetUrl}/redirected` })
    response.end()
  })
  try {
    const url = await listen(source)
    return {
      url,
      requests,
      redirectedRequests,
      close: () => Promise.all([close(source), close(target)]),
    }
  } catch (error) {
    await close(target)
    throw error
  }
}

/** Allocate a loopback-only ephemeral port for a protocol integration fixture. */
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test server address')
  return `http://127.0.0.1:${address.port}`
}

/** Release active keep-alive connections as well as the listening socket. */
async function close(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve()))
  )
}
