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

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }))

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

  it('hides redundant category controls when only document libraries are visible', () => {
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

    expect(screen.queryByTestId('knowledge-category-all-filter')).not.toBeInTheDocument()
    expect(screen.queryByTestId('knowledge-category-document-filter')).not.toBeInTheDocument()
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

it('filters only the real owning space and keeps an empty relationship empty', async () => {
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
  const { rerender } = render(<KnowledgeGroupListPage {...props} filterGroupId="group-origin" />)
  expect(screen.getByTestId('kb-row-88')).toHaveTextContent('Real space')
  expect(screen.getByRole('heading')).toHaveTextContent('Shared with me')
  expect(screen.getByTestId('knowledge-result-count')).toHaveTextContent('1')
  rerender(<KnowledgeGroupListPage {...props} filterGroupId="group-beta" />)
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

it('counts teams from the deduplicated current scope and recovers filtered empty results', async () => {
  const row = {
    ...createKnowledgeBase(101, 'Scoped notebook', 'notebook'),
    namespace: 'alpha',
    namespace_level: 'group',
    group_id: 'default',
    group_name: 'Personal',
    group_type: 'personal' as const,
    team_ids: ['alpha'],
  }
  function ScopedPage() {
    const [team, setTeam] = useState<string | null>(null)
    return (
      <KnowledgeGroupListPage
        groupId="personal"
        groupName="Created by me"
        isAllMode
        knowledgeBases={[]}
        knowledgeBasesWithGroupInfo={[row, row]}
        isLoading={false}
        onSelectKb={jest.fn()}
        onCreateKb={jest.fn()}
        filterGroupId={team}
        onFilterGroupChange={setTeam}
        availableGroups={[
          { id: 'group-alpha', name: 'alpha', displayName: 'Alpha' },
          { id: 'group-beta', name: 'beta', displayName: 'Beta' },
        ]}
      />
    )
  }
  render(<ScopedPage />)
  const user = userEvent.setup()
  expect(screen.getAllByTestId(/^kb-row-/)).toHaveLength(1)
  await user.click(screen.getByTestId('knowledge-team-filter'))
  expect(screen.getByTestId('knowledge-team-count-group-alpha')).toHaveTextContent('1')
  expect(screen.queryByTestId('knowledge-team-option-group-beta')).not.toBeInTheDocument()
  await user.type(screen.getByTestId('knowledge-team-search'), 'beta')
  expect(screen.getByTestId('knowledge-team-count-group-beta')).toHaveTextContent('0')
  await user.click(screen.getByTestId('knowledge-team-option-group-beta'))
  expect(screen.getByText('document.navigation.noFilteredKnowledge')).toBeVisible()
  expect(screen.queryByText('document.knowledgeBase.createDesc')).not.toBeInTheDocument()
  await user.click(screen.getByTestId('knowledge-clear-filters'))
  expect(screen.getByTestId('kb-row-101')).toBeInTheDocument()
  expect(screen.getByTestId('knowledge-result-title')).toHaveFocus()
  await user.type(screen.getByTestId('knowledge-search'), 'missing')
  await user.click(screen.getByTestId('knowledge-team-filter'))
  expect(screen.queryByTestId('knowledge-team-option-group-alpha')).not.toBeInTheDocument()
  await user.type(screen.getByTestId('knowledge-team-search'), 'alpha')
  expect(screen.getByTestId('knowledge-team-count-group-alpha')).toHaveTextContent('0')
  await user.keyboard('{Escape}')
  await user.click(screen.getByTestId('knowledge-clear-filters'))
  expect(screen.getByTestId('knowledge-search')).toHaveValue('')
  expect(screen.getByTestId('kb-row-101')).toBeInTheDocument()
})

it('applies the current type to team counts before applying the team selection', async () => {
  const rows = [
    {
      ...createKnowledgeBase(111, 'Notebook', 'notebook'),
      namespace: 'alpha',
      team_ids: ['alpha'],
    },
    {
      ...createKnowledgeBase(112, 'Repository', 'code_wiki'),
      namespace: 'beta',
      team_ids: ['beta'],
    },
  ].map(kb => ({
    ...kb,
    group_id: 'default',
    group_name: 'Personal',
    group_type: 'personal' as const,
  }))
  render(
    <KnowledgeGroupListPage
      groupId={null}
      groupName="All"
      isAllMode
      knowledgeBases={[]}
      knowledgeBasesWithGroupInfo={rows}
      isLoading={false}
      onSelectKb={jest.fn()}
      showAdvancedKnowledge
      onFilterGroupChange={jest.fn()}
      availableGroups={[
        { id: 'group-alpha', name: 'alpha', displayName: 'Alpha' },
        { id: 'group-beta', name: 'beta', displayName: 'Beta' },
      ]}
    />
  )
  const user = userEvent.setup()
  await user.click(screen.getByTestId('knowledge-team-filter'))
  expect(screen.getByTestId('knowledge-team-count-group-beta')).toHaveTextContent('1')
  await user.keyboard('{Escape}')
  await user.click(screen.getByTestId('knowledge-category-document-filter'))
  await user.click(screen.getByTestId('knowledge-team-filter'))
  expect(screen.getByTestId('knowledge-team-count-group-alpha')).toHaveTextContent('1')
  expect(screen.queryByTestId('knowledge-team-option-group-beta')).not.toBeInTheDocument()
  await user.type(screen.getByTestId('knowledge-team-search'), 'beta')
  expect(screen.getByTestId('knowledge-team-count-group-beta')).toHaveTextContent('0')
})

it.each([
  ['shared', 'emptyShared', 'emptySharedHint'],
  ['organization', 'emptyCompany', 'emptyCompanyHint'],
])(
  'explains a genuinely empty %s entry without suggesting a first library',
  (groupId, title, hint) => {
    render(
      <KnowledgeGroupListPage
        groupId={groupId}
        groupName={groupId}
        isAllMode
        knowledgeBases={[]}
        isLoading={false}
        onSelectKb={jest.fn()}
        onCreateKb={jest.fn()}
      />
    )
    expect(screen.getByText('document.navigation.' + title)).toBeVisible()
    expect(screen.getByText('document.navigation.' + hint)).toBeVisible()
    expect(screen.queryByText('document.knowledgeBase.createDesc')).not.toBeInTheDocument()
  }
)

it('keeps mobile secondary controls in filters and clears a hidden type condition', async () => {
  const documentKb = createKnowledgeBase(121, 'Notebook', 'notebook')
  const codeKb = createKnowledgeBase(122, 'Repository', 'code_wiki')
  function MobilePage() {
    const [advanced, setAdvanced] = useState(false)
    return (
      <KnowledgeGroupListPage
        mobile
        groupId={null}
        groupName="All"
        knowledgeBases={advanced ? [documentKb, codeKb] : [documentKb]}
        isLoading={false}
        onSelectKb={jest.fn()}
        hasAdvancedKnowledge
        showAdvancedKnowledge={advanced}
        onShowAdvancedKnowledgeChange={setAdvanced}
      />
    )
  }
  render(<MobilePage />)
  const user = userEvent.setup()
  expect(screen.queryByTestId('knowledge-sort')).not.toBeInTheDocument()
  expect(screen.queryByTestId('show-advanced-knowledge-toggle')).not.toBeInTheDocument()
  await user.click(screen.getByTestId('knowledge-mobile-filters'))
  expect(screen.getByTestId('knowledge-sort')).toBeVisible()
  await user.click(screen.getByTestId('show-advanced-knowledge-toggle'))
  await user.click(screen.getByTestId('knowledge-category-code-filter'))
  expect(screen.queryByTestId('kb-row-121')).not.toBeInTheDocument()
  expect(screen.getByTestId('kb-row-122')).toBeInTheDocument()
  await user.click(screen.getByTestId('show-advanced-knowledge-toggle'))
  expect(screen.getByTestId('kb-row-121')).toBeInTheDocument()
  expect(screen.queryByTestId('kb-row-122')).not.toBeInTheDocument()
  expect(screen.queryByTestId('knowledge-category-filter')).not.toBeInTheDocument()
})

it('filters same-name teams by identity, clears the filter, and sorts through shared selects', async () => {
  const onFilter = jest.fn()
  const libraries = [
    { ...createKnowledgeBase(91, 'Alpha', 'notebook'), namespace: 'a', team_ids: ['a'] },
    { ...createKnowledgeBase(92, 'Beta', 'notebook'), namespace: 'b', team_ids: ['b'] },
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
  expect(screen.queryByTestId('knowledge-sort')).not.toBeInTheDocument()
  await user.click(screen.getByTestId('knowledge-mobile-filters'))
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
  expect(row).not.toHaveTextContent('document.permission.role.Owner')
  expect(screen.getByRole('button', { name })).toHaveClass('break-words')
  expect(screen.queryByTestId('permission-kb-71')).not.toBeInTheDocument()
  expect(screen.getByTestId('more-kb-71')).toHaveClass('min-h-11', 'min-w-11')
  await userEvent.setup().click(screen.getByTestId('more-kb-71'))
  await userEvent.setup().click(screen.getByTestId('permission-kb-71'))
  expect(permission).toHaveBeenCalledWith(kb)
  expect(screen.queryByTestId('migrate-kb-71')).not.toBeInTheDocument()
  await userEvent.setup().click(screen.getByTestId('more-kb-71'))
  await userEvent.setup().click(screen.getByTestId('migrate-kb-71'))
  expect(migrate).toHaveBeenCalledWith(kb)
})

it('filters personal provenance independently of the creator and sharing destination', async () => {
  const rows = [
    {
      ...createKnowledgeBase(201, 'Owned personal', 'notebook'),
      namespace_level: 'personal',
      user_id: 9,
    },
    {
      ...createKnowledgeBase(202, 'Shared personal', 'notebook'),
      namespace_level: 'personal',
      user_id: 10,
      team_ids: ['alpha'],
    },
    {
      ...createKnowledgeBase(203, 'Owned team', 'notebook'),
      namespace: 'alpha',
      namespace_level: 'group',
      user_id: 9,
    },
    {
      ...createKnowledgeBase(204, 'Owned company', 'notebook'),
      namespace: 'company',
      namespace_level: 'organization',
      user_id: 9,
    },
    {
      ...createKnowledgeBase(205, 'Unknown space', 'notebook'),
      namespace: 'unknown',
      namespace_level: null,
    },
    createKnowledgeBase(206, 'Legacy personal', 'notebook'),
  ].map(kb => ({ ...kb, group_id: 'alpha', group_name: 'Alpha', group_type: 'group' as const }))
  function ScopedPage() {
    const [filter, setFilter] = useState<string | null>(null)
    return (
      <KnowledgeGroupListPage
        groupId="shared"
        groupName="Shared"
        isAllMode
        knowledgeBases={[]}
        knowledgeBasesWithGroupInfo={rows}
        isLoading={false}
        onSelectKb={jest.fn()}
        onCreateKb={jest.fn()}
        filterGroupId={filter}
        onFilterGroupChange={setFilter}
        availableGroups={[{ id: 'group-alpha', name: 'alpha', displayName: 'Alpha' }]}
      />
    )
  }
  render(<ScopedPage />)
  const user = userEvent.setup()
  await user.click(screen.getByTestId('knowledge-team-filter'))
  expect(screen.getByTestId('knowledge-space-count-personal')).toHaveTextContent('3')
  await user.click(screen.getByTestId('knowledge-space-option-personal'))
  expect(screen.getAllByTestId(/^kb-row-/)).toHaveLength(3)
  for (const id of [201, 202, 206]) expect(screen.getByTestId(`kb-row-${id}`)).toBeInTheDocument()
  for (const id of [203, 204, 205])
    expect(screen.queryByTestId(`kb-row-${id}`)).not.toBeInTheDocument()
  await user.type(screen.getByTestId('knowledge-search'), 'company')
  expect(screen.getByText('document.navigation.noFilteredKnowledge')).toBeVisible()
  await user.click(screen.getByTestId('knowledge-team-filter'))
  expect(screen.getByTestId('knowledge-space-count-personal')).toHaveTextContent('0')
  await user.keyboard('{Escape}')
  await user.click(screen.getByTestId('knowledge-clear-filters'))
  expect(screen.getAllByTestId(/^kb-row-/)).toHaveLength(6)
})

it.each([false, true])('ignores stale space filters on the company page (mobile=%s)', mobile => {
  render(
    <KnowledgeGroupListPage
      mobile={mobile}
      groupId="organization"
      groupName="Company"
      isAllMode
      knowledgeBases={[
        { ...createKnowledgeBase(301, 'Company guide', 'notebook'), namespace: 'company' },
      ]}
      isLoading={false}
      onSelectKb={jest.fn()}
      onCreateKb={jest.fn()}
      filterGroupId="space:personal"
      onFilterGroupChange={jest.fn()}
    />
  )
  expect(screen.queryByTestId('knowledge-team-filter')).not.toBeInTheDocument()
  expect(screen.getByTestId('kb-row-301')).toBeInTheDocument()
  expect(screen.getByTestId('knowledge-search')).toBeInTheDocument()
  expect(screen.queryByTestId('knowledge-clear-filters')).not.toBeInTheDocument()
})

it('counts company space after type filtering and deduplicates its rows on desktop', async () => {
  const document = {
    ...createKnowledgeBase(401, 'Company docs', 'notebook'),
    namespace: 'company',
    namespace_level: 'organization',
  }
  const code = {
    ...createKnowledgeBase(402, 'Company repo', 'code_wiki'),
    namespace: 'company',
    namespace_level: 'organization',
  }
  const personal = createKnowledgeBase(403, 'Personal', 'notebook')
  const rows = [document, document, code, personal].map(kb => ({
    ...kb,
    group_id: 'default',
    group_name: 'Personal',
    group_type: 'personal' as const,
  }))
  function AllPage() {
    const [filter, setFilter] = useState<string | null>(null)
    return (
      <KnowledgeGroupListPage
        groupId={null}
        groupName="All"
        isAllMode
        showCompanySpace
        showAdvancedKnowledge
        knowledgeBases={[]}
        knowledgeBasesWithGroupInfo={rows}
        isLoading={false}
        onSelectKb={jest.fn()}
        filterGroupId={filter}
        onFilterGroupChange={setFilter}
      />
    )
  }
  render(<AllPage />)
  const user = userEvent.setup()
  await user.click(screen.getByTestId('knowledge-team-filter'))
  expect(screen.getByTestId('knowledge-space-count-company')).toHaveTextContent('2')
  await user.click(screen.getByTestId('knowledge-space-option-company'))
  expect(screen.getAllByTestId(/^kb-row-/)).toHaveLength(2)
  expect(screen.queryByTestId('kb-row-403')).not.toBeInTheDocument()
  await user.click(screen.getByTestId('knowledge-category-document-filter'))
  expect(screen.getAllByTestId(/^kb-row-/)).toHaveLength(1)
  await user.click(screen.getByTestId('knowledge-team-filter'))
  expect(screen.getByTestId('knowledge-space-count-company')).toHaveTextContent('1')
})

it('shows only More on mobile and keeps read-only permission access available', async () => {
  const permissions = jest.fn()
  render(<KnowledgeBaseActions mobile kbId={501} onPermissions={permissions} />)
  expect(screen.getAllByRole('button')).toHaveLength(1)
  expect(screen.queryByTestId('permission-kb-501')).not.toBeInTheDocument()
  await userEvent.setup().click(screen.getByTestId('more-kb-501'))
  expect(screen.getAllByRole('menuitem')).toHaveLength(1)
  await userEvent.setup().click(screen.getByTestId('permission-kb-501'))
  expect(permissions).toHaveBeenCalledTimes(1)
})

it('hands off focus from the mobile menu before opening an action dialog', async () => {
  let origin: Element | null = null
  function MobileActions() {
    const [open, setOpen] = useState(false)
    return (
      <>
        <KnowledgeBaseActions
          mobile
          kbId={502}
          onPermissions={() => {
            origin = document.activeElement
            setOpen(true)
          }}
          onEdit={jest.fn()}
          onMigrate={jest.fn()}
          onDelete={jest.fn()}
        />
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>Permissions</DialogTitle>
            <button onClick={() => setOpen(false)}>Done viewing</button>
          </DialogContent>
        </Dialog>
      </>
    )
  }
  render(<MobileActions />)
  const user = userEvent.setup()
  await user.click(screen.getByTestId('more-kb-502'))
  expect(screen.getAllByRole('menuitem')).toHaveLength(4)
  await user.click(screen.getByTestId('permission-kb-502'))
  await user.click(await screen.findByRole('button', { name: 'Done viewing' }))
  expect(origin).toBe(screen.getByTestId('more-kb-502'))
})
