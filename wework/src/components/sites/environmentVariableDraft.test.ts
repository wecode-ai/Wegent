import { describe, expect, test } from 'vitest'
import type { EnvironmentSnapshot } from '@/api/sites'
import {
  buildEnvironmentPatchOperations,
  createEnvironmentDraft,
  validateEnvironmentDraft,
} from './environmentVariableDraft'

const snapshot: EnvironmentSnapshot = {
  revision_id: 'env-1',
  project_id: 'site-1',
  revision_number: 1,
  items: [
    {
      key: 'PUBLIC_URL',
      type: 'plain',
      value: 'https://old.example.test',
      updated_by: 'testuser',
      updated_at: '2026-09-02T08:00:00Z',
    },
    {
      key: 'API_TOKEN',
      type: 'secret',
      configured: true,
      updated_by: 'testuser',
      updated_at: '2026-09-02T08:00:00Z',
    },
  ],
}

describe('environment variable draft', () => {
  test('never places a configured Secret value in the editable draft', () => {
    const rows = createEnvironmentDraft(snapshot)
    expect(rows[1]).toMatchObject({
      key: 'API_TOKEN',
      value: '',
      valueChanged: false,
      secretConfigured: true,
    })
    expect(buildEnvironmentPatchOperations(snapshot, rows)).toEqual([])
  })

  test('only sends changed values and preserves an untouched Secret', () => {
    const rows = createEnvironmentDraft(snapshot)
    rows[0] = { ...rows[0], value: 'https://new.example.test', valueChanged: true }

    expect(buildEnvironmentPatchOperations(snapshot, rows)).toEqual([
      {
        op: 'upsert',
        key: 'PUBLIC_URL',
        type: 'plain',
        value: 'https://new.example.test',
      },
    ])
  })

  test('validates duplicate, reserved, and malformed keys before saving', () => {
    const rows = createEnvironmentDraft(snapshot)
    expect(validateEnvironmentDraft([{ ...rows[0], key: 'bad-key' }])).toBe('invalid_key')
    expect(validateEnvironmentDraft([{ ...rows[0], key: 'WEGENT_TOKEN' }])).toBe('reserved_key')
    expect(validateEnvironmentDraft([rows[0], { ...rows[1], key: rows[0].key }])).toBe(
      'duplicate_key'
    )
  })
})
