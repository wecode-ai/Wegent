import { describe, expect, test, vi } from 'vitest'
import type { HttpClient } from '@/api/http'
import { accessTargetsExtension } from './access-targets'

describe('open-source access targets extension', () => {
  test('keeps namespace-backed department search', async () => {
    const get = vi.fn().mockResolvedValue({
      items: [{ id: 7, name: 'engineering', display_name: 'Engineering' }],
    })

    const results = await accessTargetsExtension.searchDepartments(
      { get } as unknown as HttpClient,
      'engineering'
    )

    expect(get).toHaveBeenCalledWith(
      '/groups/search?q=engineering&limit=20&include_organization=true'
    )
    expect(results).toEqual([
      { entityType: 'namespace', entityId: '7', displayName: 'Engineering' },
    ])
  })
})
