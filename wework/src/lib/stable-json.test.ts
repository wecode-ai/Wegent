import { describe, expect, it } from 'vitest'
import { stableJsonStringify } from './stable-json'

describe('stable JSON serialization', () => {
  it('ignores object field order at every depth while preserving array order', () => {
    const first = {
      model: { options: { speed: 'standard', reasoning: 'low' }, name: 'session-model' },
      fallbacks: [{ region: 'local', model: 'second' }, { model: 'third' }],
    }
    const reordered = {
      fallbacks: [{ model: 'second', region: 'local' }, { model: 'third' }],
      model: { name: 'session-model', options: { reasoning: 'low', speed: 'standard' } },
    }

    expect(stableJsonStringify(first)).toBe(stableJsonStringify(reordered))
    expect(stableJsonStringify(first)).not.toBe(
      stableJsonStringify({ ...first, fallbacks: [...first.fallbacks].reverse() })
    )
    expect(first.model.options).toEqual({ speed: 'standard', reasoning: 'low' })
    expect(Object.keys(first.model.options)).toEqual(['speed', 'reasoning'])
  })

  it('preserves JSON semantics for absent, empty and null values', () => {
    expect(stableJsonStringify(undefined)).toBeUndefined()
    expect(stableJsonStringify(null)).toBe('null')
    expect(stableJsonStringify({ omitted: undefined })).toBe(stableJsonStringify({}))
    expect(stableJsonStringify({ omitted: null })).not.toBe(stableJsonStringify({}))
    expect(stableJsonStringify([undefined])).toBe(stableJsonStringify([null]))
    expect(stableJsonStringify({ options: undefined })).not.toBe(
      stableJsonStringify({ options: {} })
    )
  })

  it('orders distinct field names deterministically even when locale collation equates them', () => {
    expect(stableJsonStringify({ é: 'composed', 'e\u0301': 'decomposed' })).toBe(
      stableJsonStringify({ 'e\u0301': 'decomposed', é: 'composed' })
    )
  })
})
