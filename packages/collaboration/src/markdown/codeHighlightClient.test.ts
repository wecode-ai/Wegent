import { describe, expect, test, vi } from 'vitest'
import { CodeHighlightClient } from './codeHighlightClient'

function createClient() {
  const worker = {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null as (() => void) | null,
  }
  const factory = vi.fn(() => worker as unknown as Worker)
  return { worker, factory, client: new CodeHighlightClient(factory) }
}

describe('CodeHighlightClient', () => {
  test('routes out-of-order replies and releases the shared worker after the final owner', async () => {
    const { worker, factory, client } = createClient()
    const releaseA = client.retain()
    const releaseB = client.retain()
    const first = client.highlight('const a = 1', 'typescript')
    const second = client.highlight('select 1', 'sql')
    expect(factory).toHaveBeenCalledTimes(1)
    const [a, b] = worker.postMessage.mock.calls.map(([message]) => message.id)
    const resultA = { code: 'const a = 1', html: 'a' }
    const resultB = { code: 'select 1', html: 'b' }
    worker.onmessage!({ data: { id: b, result: resultB } } as MessageEvent)
    worker.onmessage!({ data: { id: a, result: resultA } } as MessageEvent)
    await expect(first).resolves.toEqual(resultA)
    await expect(second).resolves.toEqual(resultB)
    releaseA()
    expect(worker.terminate).not.toHaveBeenCalled()
    releaseB()
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  test('rejects pending requests on worker failure and creates a new worker for the next request', async () => {
    const { worker, factory, client } = createClient()
    const pending = client.highlight('x', 'typescript')
    const rejected = expect(pending).rejects.toThrow('worker failed')
    worker.onerror!()
    await rejected
    const next = client.highlight('y', 'typescript')
    expect(factory).toHaveBeenCalledTimes(2)
    const { id } = worker.postMessage.mock.lastCall![0]
    worker.onmessage!({ data: { id, error: 'Unsupported syntax' } } as MessageEvent)
    await expect(next).rejects.toThrow('Unsupported syntax')
    client.dispose()
  })
})
