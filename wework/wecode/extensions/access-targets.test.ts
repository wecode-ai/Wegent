import { describe, expect, test, vi } from 'vitest'
import type { HttpClient } from '@/api/http'
import { accessTargetsExtension } from './access-targets'

describe('internal access targets extension', () => {
  test('maps ERP department results to organization ACL targets', async () => {
    const get = vi.fn().mockResolvedValue({
      departments: [
        { id: '1001', name: '创新技术组', label: '创新技术组（1001）' },
        { id: '1002', name: null, label: '平台研发部' },
      ],
    })

    const results = await accessTargetsExtension.searchDepartments(
      { get } as unknown as HttpClient,
      '创新 技术'
    )

    expect(get).toHaveBeenCalledWith(
      '/internal/departments/search?q=%E5%88%9B%E6%96%B0%20%E6%8A%80%E6%9C%AF'
    )
    expect(results).toEqual([
      {
        entityType: 'org_department',
        entityId: '1001',
        displayName: '创新技术组',
      },
      {
        entityType: 'org_department',
        entityId: '1002',
        displayName: '平台研发部',
      },
    ])
  })
})
