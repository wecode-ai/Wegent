import { describe, expect, test } from 'vitest'
import { getNextBufferedStreamingText } from './useBufferedStreamingText'

describe('getNextBufferedStreamingText', () => {
  test('reveals a bounded prefix while preserving the current content', () => {
    const target = `Hello ${'world '.repeat(30)}`
    const next = getNextBufferedStreamingText('Hello ', target)

    expect(target.startsWith(next)).toBe(true)
    expect(next.length).toBeGreaterThan('Hello '.length)
    expect(next).not.toBe(target)
  })

  test('does not split Unicode code points', () => {
    expect(getNextBufferedStreamingText('', '😀你好')).toBe('😀')
  })

  test('drains a small reserve on alternating frames', () => {
    expect(getNextBufferedStreamingText('', '一二三四', false)).toBe('')
    expect(getNextBufferedStreamingText('', '一二三四', true)).toBe('一')
  })

  test('immediately adopts non-append updates', () => {
    expect(getNextBufferedStreamingText('old content', 'replacement')).toBe('replacement')
  })

  test('returns completed content unchanged', () => {
    expect(getNextBufferedStreamingText('done', 'done')).toBe('done')
  })
})
