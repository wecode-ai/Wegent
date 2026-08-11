// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import {
  KnowledgeGroupListPage,
  type KbDataItem,
} from '@/features/knowledge/document/components/KnowledgeGroupListPage'

const mockGetRuntimeConfigSync = jest.fn()

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback || key,
    i18n: { language: 'zh-CN' },
  }),
}))

jest.mock('@/lib/runtime-config', () => ({
  getRuntimeConfigSync: () => mockGetRuntimeConfigSync(),
}))

beforeEach(() => {
  mockGetRuntimeConfigSync.mockReturnValue({ enableCodeWiki: false })
})

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

function createKnowledgeBase(
  id: number,
  name: string,
  kbType: 'notebook' | 'classic' | 'code_wiki'
) {
  return {
    id,
    name,
    description: null,
    user_id: 9,
    namespace: 'default',
    document_count: 0,
    is_active: true,
    summary_enabled: false,
    kb_type: kbType,
    max_calls_per_conversation: 10,
    exempt_calls_before_check: 5,
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
  } satisfies KbDataItem
}

describe('KnowledgeGroupListPage category filter', () => {
  it('groups notebook and classic bases as documents, separately from code wikis', async () => {
    const user = userEvent.setup()
    render(
      <KnowledgeGroupListPage
        groupId="personal"
        groupName="Personal"
        knowledgeBases={[
          createKnowledgeBase(1, 'Notebook', 'notebook'),
          createKnowledgeBase(2, 'Classic', 'classic'),
          createKnowledgeBase(3, 'Code Wiki', 'code_wiki'),
        ]}
        isLoading={false}
        onSelectKb={jest.fn()}
      />
    )

    expect(screen.getByTestId('knowledge-category-code-filter')).toBeInTheDocument()

    await user.click(screen.getByTestId('knowledge-category-code-filter'))
    expect(screen.queryByTestId('kb-row-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('kb-row-2')).not.toBeInTheDocument()
    expect(screen.getByTestId('kb-row-3')).toBeInTheDocument()

    await user.click(screen.getByTestId('knowledge-category-document-filter'))
    expect(screen.getByTestId('kb-row-1')).toBeInTheDocument()
    expect(screen.getByTestId('kb-row-2')).toBeInTheDocument()
    expect(screen.queryByTestId('kb-row-3')).not.toBeInTheDocument()
  })

  it('hides the code filter when creation is disabled and no code wiki is visible', () => {
    render(
      <KnowledgeGroupListPage
        groupId="personal"
        groupName="Personal"
        knowledgeBases={[createKnowledgeBase(1, 'Notebook', 'notebook')]}
        isLoading={false}
        onSelectKb={jest.fn()}
      />
    )

    expect(screen.getByTestId('knowledge-category-all-filter')).toBeInTheDocument()
    expect(screen.getByTestId('knowledge-category-document-filter')).toBeInTheDocument()
    expect(screen.queryByTestId('knowledge-category-code-filter')).not.toBeInTheDocument()
  })

  it('shows the code filter when Code Wiki creation is enabled', () => {
    mockGetRuntimeConfigSync.mockReturnValue({ enableCodeWiki: true })
    render(
      <KnowledgeGroupListPage
        groupId="personal"
        groupName="Personal"
        knowledgeBases={[createKnowledgeBase(1, 'Notebook', 'notebook')]}
        isLoading={false}
        onSelectKb={jest.fn()}
      />
    )

    expect(screen.getByTestId('knowledge-category-code-filter')).toBeInTheDocument()
  })
})
