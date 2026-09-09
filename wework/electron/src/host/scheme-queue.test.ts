import { describe, expect, it } from 'vitest'
import { SchemeQueue } from './scheme-queue.js'

describe('SchemeQueue', () => {
  it('retains requests across renderer reads until each navigation is acknowledged', () => {
    const queue = new SchemeQueue()
    queue.enqueue('wework://boards/1')
    const first = queue.read()
    expect(queue.read()).toEqual(first)
    queue.enqueue('wework://boards/2')
    queue.acknowledge(first[0]!.id)
    expect(queue.read().map(request => request.url)).toEqual(['wework://boards/2'])
    queue.acknowledge(first[0]!.id)
    expect(queue.read()).toHaveLength(1)
  })

  it('rejects unrelated protocols and oversized input', () => {
    const queue = new SchemeQueue()
    expect(queue.enqueue('https://example.com')).toBe(false)
    expect(queue.enqueue(`wework://${'x'.repeat(2048)}`)).toBe(false)
    expect(queue.read()).toEqual([])
  })
})
