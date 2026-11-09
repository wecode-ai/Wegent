import { fork } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readRequestBody } from './response-protocol.mjs'
import { rejectModelWebSocketUpgrade } from './reject-model-upgrade.mjs'

/** Capture the model boundary in a separate process, outside the application and executor. */
export async function startModelRequestCapture({ target, resultDir }) {
  const child = fork(fileURLToPath(import.meta.url), [target, resultDir], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  try {
    const url = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Model capture service did not start')),
        10_000
      )
      const finish = callback => value => {
        clearTimeout(timeout)
        child.off('error', onError)
        child.off('exit', onExit)
        child.off('message', onMessage)
        callback(value)
      }
      const onError = finish(reject)
      const onExit = finish(code => reject(new Error(`Model capture service exited: ${code}`)))
      const onMessage = finish(message => resolve(message.url))
      child.once('error', onError)
      child.once('exit', onExit)
      child.once('message', onMessage)
    })
    return { url, pid: child.pid, close: () => child.kill() }
  } catch (error) {
    child.kill()
    throw error
  }
}

async function serve(target, resultDir) {
  await mkdir(resultDir, { recursive: true })
  const server = createServer((request, response) => {
    void forward(request, response).catch(error => {
      console.error(error)
      response.writeHead(502, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: error.message } }))
    })
  })
  async function forward(request, response) {
    let payload
    if (request.method === 'POST') {
      const body = await readRequestBody(request)
      // Never persist authentication headers; only synthetic E2E model payloads are evidence.
      await appendFile(join(resultDir, 'requests.jsonl'), JSON.stringify(body) + '\n')
      payload = Buffer.from(JSON.stringify(body))
    }
    const headers = { ...request.headers }
    delete headers.host
    delete headers['content-encoding']
    delete headers['transfer-encoding']
    if (payload) headers['content-length'] = String(payload.length)
    await new Promise((resolve, reject) => {
      const upstream = httpRequest(new URL(request.url, target), {
        method: request.method,
        headers,
      })
      upstream.once('response', incoming => {
        response.writeHead(incoming.statusCode, incoming.headers)
        incoming.pipe(response)
        incoming.once('end', resolve)
        incoming.once('error', reject)
      })
      upstream.once('error', reject)
      upstream.end(payload)
    })
  }
  server.on('upgrade', (_request, socket) => rejectModelWebSocketUpgrade(server, socket))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  process.on('disconnect', () => {
    server.closeAllConnections()
    server.close()
  })
  process.send({ url: `http://127.0.0.1:${server.address().port}` })
}

if (process.send && process.argv[1] === fileURLToPath(import.meta.url)) {
  await serve(process.argv[2], process.argv[3])
}
