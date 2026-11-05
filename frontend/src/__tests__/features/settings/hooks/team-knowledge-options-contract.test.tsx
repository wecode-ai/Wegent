// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor, renderHook } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { knowledgeBaseApi } from '@/apis/knowledge-base'
import { useKnowledgeBaseOptions } from '@/features/settings/hooks/useKnowledgeBaseOptions'
import { KnowledgeBaseMultiSelector } from '@/features/settings/components/knowledge/KnowledgeBaseMultiSelector'

jest.mock('@/apis/knowledge-base', () => ({ knowledgeBaseApi: { getAllGrouped: jest.fn() } }))
jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
}))
const ownedTeam = {
  id: 72,
  name: 'Owned team library',
  namespace: 'source',
  user_id: 1,
  description: null,
  document_count: 0,
  kb_type: 'notebook',
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
  group_id: 'source',
  group_name: 'Source team',
  group_type: 'group',
  my_role: 'Developer',
}
const grouped = {
  personal: { created_by_me: [], shared_with_me: [] },
  groups: [
    {
      group_name: 'source',
      group_display_name: 'Source team',
      kb_count: 1,
      knowledge_bases: [ownedTeam],
    },
  ],
  organization: { namespace: null, display_name: null, kb_count: 0, knowledge_bases: [] },
  summary: { total_count: 1, personal_count: 0, group_count: 1, organization_count: 0 },
}

beforeEach(() => jest.mocked(knowledgeBaseApi.getAllGrouped).mockResolvedValue(grouped as never))

it('keeps an owned native team library classified as a team option', async () => {
  const { result } = renderHook(() => useKnowledgeBaseOptions())
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.options).toEqual([
    expect.objectContaining({
      id: 72,
      namespace: 'source',
      source: 'group',
      groupName: 'Source team',
    }),
  ])
})

it('allows that library in team agent and bot configuration without personal sources', async () => {
  const change = jest.fn()
  render(
    <KnowledgeBaseMultiSelector
      value={[]}
      onChange={change}
      allowedSources={['group', 'organization']}
      allowedGroupNamespaces={['source']}
    />
  )
  const user = userEvent.setup()
  await user.click(screen.getByTestId('default-knowledge-base-trigger'))
  await user.click(await screen.findByText('Owned team library'))
  expect(change).toHaveBeenCalledWith([{ id: 72, name: 'Owned team library' }])
})
