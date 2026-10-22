import { createHash } from 'crypto'
import type { IncomingMessage, ServerResponse } from 'http'

export const E2E_EMBEDDING_DIMENSIONS = 32

type EmbeddingBarrier = {
  parties: number
  waiting: Map<string, { release: () => void; fail: () => void }>
  peakPending: number
  arrivals: number
  released: boolean
  timedOut: boolean
}
const barriers = new Map<string, EmbeddingBarrier>()

/** Hold a dedicated model's first batch until all real index workers arrive. */
async function waitForEmbeddingPeers(model: string, inputs: string[]): Promise<void> {
  const barrier = barriers.get(model)
  if (!barrier) return
  if (barrier.timedOut) throw new Error('Embedding concurrency barrier permanently failed')
  if (barrier.released) return
  const fingerprint = createHash('sha256').update(JSON.stringify(inputs)).digest('hex')
  if (barrier.waiting.has(fingerprint)) throw new Error('Duplicate pending document input')
  barrier.arrivals += 1
  await new Promise<void>((resolve, reject) => {
    const fail = () => {
      clearTimeout(timer)
      reject(new Error('Four distinct concurrent index workers did not reach the model'))
    }
    const timer = setTimeout(() => {
      barrier.timedOut = true
      for (const pending of barrier.waiting.values()) pending.fail()
      barrier.waiting.clear()
    }, 30000)
    barrier.waiting.set(fingerprint, {
      release: () => {
        clearTimeout(timer)
        resolve()
      },
      fail,
    })
    barrier.peakPending = Math.max(barrier.peakPending, barrier.waiting.size)
    if (barrier.waiting.size === barrier.parties) {
      barrier.released = true
      for (const pending of barrier.waiting.values()) pending.release()
      barrier.waiting.clear()
    }
  })
}

/** Simulate only the external embedding API; indexing and storage stay real. */
export async function handleEmbeddingRequest(
  request: IncomingMessage,
  response: ServerResponse,
  body: string
): Promise<boolean> {
  if (request.url === '/embedding-control/barrier' && request.method === 'POST') {
    const { model, action } = JSON.parse(body)
    if (typeof model !== 'string' || !model) {
      response.writeHead(400).end('A dedicated model name is required')
      return true
    }
    if (action === 'arm') {
      barriers.set(model, {
        parties: 4,
        waiting: new Map(),
        peakPending: 0,
        arrivals: 0,
        released: false,
        timedOut: false,
      })
    } else if (action === 'clear') {
      barriers.delete(model)
    } else if (action !== 'status') {
      response.writeHead(400).end('Unknown barrier action')
      return true
    }
    const barrier = barriers.get(model)
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        arrivals: barrier?.arrivals ?? 0,
        peak_pending: barrier?.peakPending ?? 0,
        released: barrier?.released ?? false,
        timed_out: barrier?.timedOut ?? false,
      })
    )
    return true
  }
  if (request.url !== '/v1/embeddings' || request.method !== 'POST') return false
  let payload
  try {
    payload = JSON.parse(body)
  } catch {
    response.writeHead(400).end('Invalid JSON')
    return true
  }
  const inputs = typeof payload?.input === 'string' ? [payload.input] : payload?.input
  if (
    !Array.isArray(inputs) ||
    inputs.length === 0 ||
    inputs.some(input => typeof input !== 'string' || input.length === 0) ||
    (payload.dimensions !== undefined && payload.dimensions !== E2E_EMBEDDING_DIMENSIONS)
  ) {
    response.writeHead(400).end('Expected non-empty text input and 32 dimensions')
    return true
  }
  try {
    await waitForEmbeddingPeers(payload.model, inputs)
  } catch (error) {
    response.writeHead(503).end(String(error))
    return true
  }
  const data = inputs.map((input: string, index: number) => {
    // Keep every component positive: index text carries metadata while a query
    // text does not, so a signed distribution makes any retrieval assertion a
    // coin flip against a score threshold. Positive components keep the vector
    // text-dependent while guaranteeing a positive similarity for real queries.
    const values = [...createHash('sha256').update(input).digest()].map(value => (value + 1) / 256)
    const norm = Math.hypot(...values)
    return { object: 'embedding', index, embedding: values.map(value => value / norm) }
  })
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(
    JSON.stringify({
      object: 'list',
      model: payload.model,
      data,
      usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
    })
  )
  return true
}
