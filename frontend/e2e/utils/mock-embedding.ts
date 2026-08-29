import { createHash } from 'crypto'
import type { IncomingMessage, ServerResponse } from 'http'

export const E2E_EMBEDDING_DIMENSIONS = 32

/** Simulate only the external embedding API; indexing and storage stay real. */
export function handleEmbeddingRequest(
  request: IncomingMessage,
  response: ServerResponse,
  body: string
): boolean {
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
  const data = inputs.map((input: string, index: number) => {
    const values = [...createHash('sha256').update(input).digest()].map(
      value => (value - 127.5) / 127.5
    )
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
