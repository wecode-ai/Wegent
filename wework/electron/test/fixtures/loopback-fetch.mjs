import { get } from 'node:http'

/** A real HTTP adapter for the unit fixture's loopback servers, never production. */
export function loopbackFetch(input, init = {}) {
  const url = new URL(input)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
    throw new Error('The unit HTTP adapter accepts only its own IPv4 loopback servers')
  }
  return new Promise((resolve, reject) => {
    const request = get(url, { signal: init.signal }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.once('error', reject)
      response.once('end', () => {
        const bytes = Buffer.concat(chunks)
        try {
          resolve(new Response(bytes.length ? bytes : null, { status: response.statusCode }))
        } catch (error) {
          reject(error)
        }
      })
    })
    request.once('error', reject)
  })
}
