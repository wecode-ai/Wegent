// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { KnowledgeBaseActions } from '@/features/knowledge/document/components/KnowledgeBaseActions'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

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
    expect(screen.queryByTestId('more-kb-1')).not.toBeInTheDocument()
  })

  it('hides kb edit and delete actions when canManageKb returns false', () => {
    renderPage({ canManageKb: () => false })

    expect(screen.queryByTestId('edit-kb-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('delete-kb-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('more-kb-1')).not.toBeInTheDocument()
  })

  it('shows edit and puts delete in the more menu when canManageKb returns true', async () => {
    renderPage({ canManageKb: () => true })

    expect(screen.getByTestId('edit-kb-1')).toBeInTheDocument()
    expect(screen.queryByTestId('delete-kb-1')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByTestId('more-kb-1'))
    expect(screen.getByTestId('delete-kb-1')).toBeInTheDocument()
  })
})

it('runs more-menu actions without opening the knowledge base row', async () => {
  const onOpen = jest.fn()
  const onMigrate = jest.fn()
  const onDelete = jest.fn()
  render(
    <div onClick={onOpen}>
      <KnowledgeBaseActions kbId={8} onMigrate={onMigrate} onDelete={onDelete} />
    </div>
  )
  const user = userEvent.setup()
  expect(screen.queryByTestId('migrate-kb-8')).not.toBeInTheDocument()
  expect(screen.queryByTestId('delete-kb-8')).not.toBeInTheDocument()
  await user.click(screen.getByTestId('more-kb-8'))
  await user.click(screen.getByTestId('migrate-kb-8'))
  expect(onMigrate).toHaveBeenCalledTimes(1)
  await user.click(screen.getByTestId('more-kb-8'))
  await user.click(screen.getByTestId('delete-kb-8'))
  expect(onDelete).toHaveBeenCalledTimes(1)
  expect(onOpen).not.toHaveBeenCalled()
})

it('keeps focus inside an action dialog opened from more and closes with Escape', async () => {
  function ActionsWithDialog() {
    const [open, setOpen] = useState(false)
    return (
      <>
        <KnowledgeBaseActions kbId={12} onDelete={() => setOpen(true)} />
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>Delete library</DialogTitle>
            <button onClick={() => setOpen(false)}>Cancel delete</button>
          </DialogContent>
        </Dialog>
      </>
    )
  }
  render(<ActionsWithDialog />)
  const user = userEvent.setup()
  const more = screen.getByTestId('more-kb-12')
  await user.click(more)
  await user.click(screen.getByTestId('delete-kb-12'))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel delete' })).toHaveFocus())
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
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
  it('shows the advanced toggle and forwards changes', async () => {
    const user = userEvent.setup()
    const onShowAdvancedKnowledgeChange = jest.fn()
    render(
      <KnowledgeGroupListPage
        groupId="engineering"
        groupName="Engineering"
        knowledgeBases={[createKnowledgeBase(1, 'Notebook', 'notebook')]}
        isLoading={false}
        onSelectKb={jest.fn()}
        hasAdvancedKnowledge
        onShowAdvancedKnowledgeChange={onShowAdvancedKnowledgeChange}
      />
    )

    const toggle = screen.getByTestId('show-advanced-knowledge-toggle')
    expect(toggle).toBeInTheDocument()

    await user.click(toggle)

    expect(onShowAdvancedKnowledgeChange).toHaveBeenCalledWith(true)
  })

  it('does not show the advanced toggle when no advanced knowledge is available', () => {
    render(
      <KnowledgeGroupListPage
        groupId="engineering"
        groupName="Engineering"
        knowledgeBases={[createKnowledgeBase(1, 'Notebook', 'notebook')]}
        isLoading={false}
        onSelectKb={jest.fn()}
        onShowAdvancedKnowledgeChange={jest.fn()}
      />
    )

    expect(screen.queryByTestId('show-advanced-knowledge-toggle')).not.toBeInTheDocument()
  })

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
        showAdvancedKnowledge
      />
    )

    expect(screen.getByTestId('knowledge-category-code-filter')).toBeInTheDocument()
    expect(screen.getByTestId('knowledge-category-filter')).toHaveAttribute('role', 'group')

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
        showAdvancedKnowledge
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
        showAdvancedKnowledge
      />
    )

    expect(screen.getByTestId('knowledge-category-code-filter')).toBeInTheDocument()
  })

  it('returns to all when the selected code category is no longer available', async () => {
    const user = userEvent.setup()
    const sharedProps = {
      groupId: 'personal',
      groupName: 'Personal',
      isLoading: false,
      onSelectKb: jest.fn(),
      showAdvancedKnowledge: true,
    }
    const { rerender } = render(
      <KnowledgeGroupListPage
        {...sharedProps}
        knowledgeBases={[
          createKnowledgeBase(1, 'Notebook', 'notebook'),
          createKnowledgeBase(2, 'Code Wiki', 'code_wiki'),
        ]}
      />
    )

    await user.click(screen.getByTestId('knowledge-category-code-filter'))
    rerender(
      <KnowledgeGroupListPage
        {...sharedProps}
        knowledgeBases={[createKnowledgeBase(1, 'Notebook', 'notebook')]}
      />
    )

    await waitFor(() => expect(screen.getByTestId('kb-row-1')).toBeInTheDocument())
    expect(screen.queryByTestId('knowledge-category-code-filter')).not.toBeInTheDocument()
  })
})

it('filters all receiving teams, preserves real space, and keeps an empty relationship empty', async () => {
  const shared = {
    ...createKnowledgeBase(88, 'Multi-team library', 'notebook'),
    group_id: 'alpha',
    group_name: 'Receiving team',
    group_type: 'group' as const,
    namespace: 'origin',
    namespace_level: 'group',
    namespace_display_name: 'Real space',
    team_ids: ['alpha', 'beta'],
    my_role: 'Reporter' as const,
  }
  const props = {
    groupId: null,
    groupName: 'Shared with me',
    knowledgeBases: [],
    knowledgeBasesWithGroupInfo: [shared],
    isLoading: false,
    onSelectKb: jest.fn(),
    isAllMode: true,
    getKbGroupInfo: () => ({
      groupId: 'origin',
      groupName: 'Real space',
      groupType: 'group' as const,
    }),
  }
  const { rerender } = render(<KnowledgeGroupListPage {...props} filterGroupId="group-beta" />)
  expect(screen.getByTestId('kb-row-88')).toHaveTextContent('Real space')
  expect(screen.getByRole('heading')).toHaveTextContent('Shared with me')
  expect(screen.getByTestId('knowledge-result-count')).toHaveTextContent('1')
  rerender(<KnowledgeGroupListPage {...props} filterGroupId="group-gamma" />)
  expect(screen.queryByTestId('kb-row-88')).not.toBeInTheDocument()
  rerender(
    <KnowledgeGroupListPage {...props} knowledgeBases={[shared]} knowledgeBasesWithGroupInfo={[]} />
  )
  expect(screen.queryByTestId('kb-row-88')).not.toBeInTheDocument()
})

it('reports the search result count without changing the relationship title', async () => {
  render(
    <KnowledgeGroupListPage
      groupId={null}
      groupName="Created by me"
      knowledgeBases={[createKnowledgeBase(99, 'Architecture', 'notebook')]}
      isAllMode
      isLoading={false}
      onSelectKb={jest.fn()}
    />
  )
  await userEvent.setup().type(screen.getByTestId('knowledge-search'), 'missing')
  expect(screen.getByTestId('knowledge-result-count')).toHaveTextContent('0')
  expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Created by me')
})

it('filters same-name teams by identity, clears the filter, and sorts through shared selects', async () => {
  const onFilter = jest.fn()
  const libraries = [
    { ...createKnowledgeBase(91, 'Alpha', 'notebook'), team_ids: ['a'] },
    { ...createKnowledgeBase(92, 'Beta', 'notebook'), team_ids: ['b'] },
  ]
  function PageWithFilters() {
    const [team, setTeam] = useState<string | null>(null)
    return (
      <KnowledgeGroupListPage
        mobile
        isAllMode
        groupId={null}
        groupName="All knowledge"
        getKbGroupInfo={() => ({
          groupId: 'default',
          groupName: 'Personal space',
          groupType: 'personal',
        })}
        knowledgeBases={[]}
        knowledgeBasesWithGroupInfo={libraries.map(kb => ({
          ...kb,
          group_id: 'default',
          group_name: 'Personal',
          group_type: 'personal',
        }))}
        isLoading={false}
        onSelectKb={jest.fn()}
        filterGroupId={team}
        onFilterGroupChange={value => {
          onFilter(value)
          setTeam(value)
        }}
        availableGroups={[
          { id: 'group-a', name: 'a', displayName: 'Same team' },
          { id: 'group-b', name: 'b', displayName: 'Same team' },
        ]}
      />
    )
  }
  render(<PageWithFilters />)
  const user = userEvent.setup()
  await user.click(screen.getByTestId('knowledge-team-filter'))
  await user.click(screen.getByTestId('knowledge-team-option-group-b'))
  expect(onFilter).toHaveBeenLastCalledWith('group-b')
  expect(screen.queryByTestId('kb-row-91')).not.toBeInTheDocument()
  expect(screen.getByTestId('kb-row-92')).toBeInTheDocument()
  expect(screen.getByTestId('knowledge-team-filter')).toHaveTextContent('Same team')
  await user.click(screen.getByTestId('knowledge-team-filter'))
  await user.click(screen.getByTestId('knowledge-team-option-all'))
  expect(onFilter).toHaveBeenLastCalledWith(null)
  expect(screen.getAllByTestId(/^kb-row-/)).toHaveLength(2)
  await user.click(screen.getByTestId('knowledge-sort'))
  await user.click(screen.getByTestId('knowledge-sort-option-name'))
  await user.click(screen.getByTestId('knowledge-sort-direction'))
  expect(screen.getAllByTestId(/^kb-row-/).map(row => row.getAttribute('data-testid'))).toEqual([
    'kb-row-91',
    'kb-row-92',
  ])
})

it('uses readable vertical mobile rows with space, role, permission and migration controls', async () => {
  const name = 'A very long library title that must remain fully readable on a small phone'
  const kb = {
    ...createKnowledgeBase(71, name, 'notebook'),
    group_id: 'default',
    group_name: 'Personal',
    group_type: 'personal' as const,
    my_role: 'Owner' as const,
  }
  const permission = jest.fn(),
    migrate = jest.fn()
  render(
    <KnowledgeGroupListPage
      mobile
      groupId={null}
      groupName="Created by me"
      knowledgeBases={[]}
      knowledgeBasesWithGroupInfo={[kb]}
      isLoading={false}
      onSelectKb={jest.fn()}
      getKbGroupInfo={() => ({
        groupId: 'default',
        groupName: 'Personal space',
        groupType: 'personal',
      })}
      onViewPermissions={permission}
      onMigrateKb={migrate}
      canMigrate={() => true}
    />
  )
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
  const row = screen.getByTestId('kb-row-71')
  expect(row).toHaveTextContent(name)
  expect(row).toHaveTextContent('Personal space')
  expect(row).toHaveTextContent('document.permission.role.Owner')
  expect(screen.getByRole('button', { name })).toHaveClass('break-words')
  expect(screen.getByTestId('permission-kb-71')).toHaveClass('min-h-11', 'min-w-11')
  await userEvent.setup().click(screen.getByTestId('permission-kb-71'))
  expect(permission).toHaveBeenCalledWith(kb)
  expect(screen.queryByTestId('migrate-kb-71')).not.toBeInTheDocument()
  await userEvent.setup().click(screen.getByTestId('more-kb-71'))
  await userEvent.setup().click(screen.getByTestId('migrate-kb-71'))
  expect(migrate).toHaveBeenCalledWith(kb)
})
