// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, waitFor } from '@testing-library/react'
import KnowledgeBaseCompatPage from '@/app/(tasks)/knowledge/document/[knowledgeBaseId]/page'
import { getOrganizationNamespace } from '@/apis/knowledge'
import { useKnowledgeBaseDetail } from '@/features/knowledge/document/hooks'

const mockReplace = jest.fn()
let mockSearchParams = new URLSearchParams()

jest.mock('next/navigation', () => ({
  useParams: () => ({ knowledgeBaseId: '42' }),
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}))

jest.mock('@/apis/knowledge', () => ({
  getOrganizationNamespace: jest.fn(),
}))

jest.mock('@/features/knowledge/document/hooks', () => ({
  useKnowledgeBaseDetail: jest.fn(),
}))

const mockedGetOrganizationNamespace = getOrganizationNamespace as jest.MockedFunction<
  typeof getOrganizationNamespace
>
const mockedUseKnowledgeBaseDetail = useKnowledgeBaseDetail as jest.MockedFunction<
  typeof useKnowledgeBaseDetail
>

describe('legacy knowledge document redirect', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSearchParams = new URLSearchParams('view=notebook&taskId=123')
  })

  it('redirects organization KBs with the public virtual URL and preserves query params', async () => {
    mockedGetOrganizationNamespace.mockResolvedValue({ namespace: 'acme-org' })
    mockedUseKnowledgeBaseDetail.mockReturnValue({
      knowledgeBase: {
        id: 42,
        name: '产品知识库',
        description: null,
        user_id: 1,
        namespace: 'acme-org',
        document_count: 0,
        is_active: true,
        summary_enabled: false,
        max_calls_per_conversation: 10,
        exempt_calls_before_check: 5,
        created_at: '2026-07-05T00:00:00Z',
        updated_at: '2026-07-05T00:00:00Z',
        kb_type: 'notebook',
      },
      loading: false,
      error: null,
      accessDenied: false,
      refresh: jest.fn(),
    })

    render(<KnowledgeBaseCompatPage />)

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith(
        '/knowledge/public/%E4%BA%A7%E5%93%81%E7%9F%A5%E8%AF%86%E5%BA%93?view=notebook&taskId=123'
      )
    })
  })

  it('redirects personal KBs with the default namespace URL and preserves query params', async () => {
    mockedGetOrganizationNamespace.mockResolvedValue({ namespace: 'acme-org' })
    mockedUseKnowledgeBaseDetail.mockReturnValue({
      knowledgeBase: {
        id: 42,
        name: 'my kb',
        description: null,
        user_id: 1,
        namespace: 'default',
        document_count: 0,
        is_active: true,
        summary_enabled: false,
        max_calls_per_conversation: 10,
        exempt_calls_before_check: 5,
        created_at: '2026-07-05T00:00:00Z',
        updated_at: '2026-07-05T00:00:00Z',
        kb_type: 'classic',
      },
      loading: false,
      error: null,
      accessDenied: false,
      refresh: jest.fn(),
    })

    render(<KnowledgeBaseCompatPage />)

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith(
        '/knowledge/default/my%20kb?view=notebook&taskId=123'
      )
    })
  })
})
