// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from '@testing-library/react'

import {
  KnowledgeGroupListPage,
  type KbDataItem,
} from '@/features/knowledge/document/components/KnowledgeGroupListPage'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback || key,
  }),
}))

function renderPage(overrides?: { canManageKb?: (kb: KbDataItem) => boolean }) {
  const sharedKb: KbDataItem = {
    id: 1,
    name: 'Shared KB',
    description: null,
    kb_type: 'notebook',
    namespace: 'default',
    document_count: 0,
    updated_at: '2026-04-01T00:00:00Z',
    created_at: '2026-04-01T00:00:00Z',
    user_id: 9,
    group_id: 'default',
    group_name: 'personal-shared',
    group_type: 'personal-shared',
    my_role: 'Reporter',
  }

  render(
    <KnowledgeGroupListPage
      groupId="personal"
      groupName="Personal"
      knowledgeBases={[]}
      knowledgeBasesWithGroupInfo={[sharedKb]}
      isLoading={false}
      onSelectKb={jest.fn()}
      onEditKb={jest.fn()}
      onDeleteKb={jest.fn()}
      canManageKb={overrides?.canManageKb}
      isPersonalMode={true}
      personalCreatedByMe={[]}
      personalSharedWithMe={[sharedKb]}
    />
  )
}

describe('KnowledgeGroupListPage permissions', () => {
  it('hides kb edit and delete actions when canManageKb is omitted', () => {
    renderPage()

    expect(screen.queryByTestId('edit-kb-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('delete-kb-1')).not.toBeInTheDocument()
  })

  it('hides kb edit and delete actions when canManageKb returns false', () => {
    renderPage({ canManageKb: () => false })

    expect(screen.queryByTestId('edit-kb-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('delete-kb-1')).not.toBeInTheDocument()
  })

  it('shows kb edit and delete actions when canManageKb returns true', () => {
    renderPage({ canManageKb: () => true })

    expect(screen.getByTestId('edit-kb-1')).toBeInTheDocument()
    expect(screen.getByTestId('delete-kb-1')).toBeInTheDocument()
  })
})
