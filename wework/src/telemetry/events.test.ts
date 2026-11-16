import { describe, expect, it } from 'vitest'
import { sanitizeAnalyticsProperties } from './client'

describe('feature-opened telemetry contract', () => {
  it.each(['workbench', 'collaboration_exp'] as const)(
    'retains the %s feature while dropping private properties',
    feature => {
      const properties = { feature, prompt: 'Private discussion', project_id: 'private-project' }

      expect(sanitizeAnalyticsProperties('feature_opened', properties)).toEqual({ feature })
    }
  )

  it('drops an arbitrary feature value', () => {
    expect(
      sanitizeAnalyticsProperties('feature_opened', {
        feature: 'Private discussion' as 'collaboration_exp',
      })
    ).toEqual({})
  })
})
