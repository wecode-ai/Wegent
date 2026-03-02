import { describe, it, expect } from 'vitest'
import { parseSubscriptionSchemeUrl, SUBSCRIPTION_SCHEME } from '../subscription'

describe('parseSubscriptionSchemeUrl', () => {
  it('should return subscription ID for valid subscription:// URL', () => {
    expect(parseSubscriptionSchemeUrl('subscription://123')).toBe(123)
    expect(parseSubscriptionSchemeUrl('subscription://456789')).toBe(456789)
  })

  it('should return null for invalid URLs', () => {
    expect(parseSubscriptionSchemeUrl('attachment://123')).toBeNull()
    expect(parseSubscriptionSchemeUrl('wegent://subscriptions/123')).toBeNull()
    expect(parseSubscriptionSchemeUrl('subscription://')).toBeNull()
    expect(parseSubscriptionSchemeUrl('subscription://abc')).toBeNull()
    expect(parseSubscriptionSchemeUrl('')).toBeNull()
    expect(parseSubscriptionSchemeUrl(null)).toBeNull()
    expect(parseSubscriptionSchemeUrl(undefined)).toBeNull()
  })

  it('should handle whitespace', () => {
    expect(parseSubscriptionSchemeUrl('  subscription://123  ')).toBe(123)
  })
})

describe('SUBSCRIPTION_SCHEME', () => {
  it('should have correct scheme value', () => {
    expect(SUBSCRIPTION_SCHEME).toBe('subscription://')
  })
})
