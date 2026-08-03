// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { listGroups } from '@/apis/groups'
import { resourceLibraryApi } from '@/apis/resourceLibrary'
import { getSkill } from '@/apis/skills'
import { PublishedResources } from '@/features/resource-library/components/PublishedResources'
import type { ResourceLibraryListing } from '@/features/resource-library/types'

jest.mock('@/apis/resourceLibrary', () => ({
  resourceLibraryApi: {
    listMyPublished: jest.fn(),
    updatePublication: jest.fn(),
  },
}))

jest.mock('@/apis/groups', () => ({
  listGroups: jest.fn(),
}))

jest.mock('@/apis/skills', () => ({
  getSkill: jest.fn(),
}))

jest.mock('@/features/settings/components/skills/SkillUploadModal', () => ({
  __esModule: true,
  default: ({
    open,
    onClose,
  }: {
    open: boolean
    onClose: (saved: boolean, skillId?: number) => void
  }) =>
    open ? (
      <button
        type="button"
        data-testid="complete-skill-version-upload"
        onClick={() => onClose(true, 7)}
      >
        完成上传
      </button>
    ) : null,
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'status.published': '已发布',
        'publication.settings': '发布设置',
        'publication.edit_scope': '编辑发布范围',
        'publication.edit_scope_description': '修改发布范围',
        'publication.target_groups_count': '1 个目标团队',
        'new_capability.scope_title': '发布范围',
        'new_capability.existing_scope_description': '修改发布范围',
        'new_capability.scopes.personal': '私有',
        'new_capability.scopes.team': '团队',
        'new_capability.scopes.marketplace': '市场',
        'new_capability.group': '目标团队',
        'sources.selected_groups': '已选择 1 个团队',
        'actions.save': '保存',
        'actions.cancel': '取消',
        'actions.archive': '归档',
        'actions.edit_and_publish': '编辑并发布新版本',
        'messages.update_success': '更新成功',
        'messages.update_failed': '更新失败',
      })[key] || key,
  }),
}))

const mockResourceLibraryApi = resourceLibraryApi as jest.Mocked<typeof resourceLibraryApi>
const mockedGetSkill = getSkill as jest.MockedFunction<typeof getSkill>
const mockedListGroups = listGroups as jest.MockedFunction<typeof listGroups>

describe('PublishedResources', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockResourceLibraryApi.listMyPublished.mockResolvedValue({
      items: [
        {
          id: 7,
          resource_type: 'skill',
          name: 'h52wbox-cloud',
          display_name: 'h52wbox-cloud',
          description: '云端发布技能',
          tags: [],
          publisher_user_id: 1,
          publisher_user_name: 'yansheng3',
          status: 'published',
          current_version: {
            id: 1,
            version: '1.0.0',
            created_at: '2026-07-28T00:00:00Z',
          },
          install_count: 1,
          is_installed: true,
          bind_modes: [],
          allow_personal_install: true,
          allow_group_install: false,
          created_at: '2026-07-28T00:00:00Z',
          updated_at: '2026-07-28T00:00:00Z',
        },
      ],
      total: 1,
    })
    mockResourceLibraryApi.updatePublication.mockResolvedValue({} as ResourceLibraryListing)
    mockedListGroups.mockResolvedValue({
      total: 1,
      items: [
        {
          id: 11,
          name: 'team-a',
          display_name: '团队 A',
          parent_name: null,
          owner_user_id: 1,
          visibility: 'private',
          description: null,
          is_active: true,
          my_role: 'Developer',
          created_at: '2026-07-28T00:00:00Z',
          updated_at: '2026-07-28T00:00:00Z',
        },
      ],
    })
    mockedGetSkill.mockResolvedValue({
      apiVersion: 'agent.wecode.io/v1',
      kind: 'Skill',
      metadata: {
        name: 'h52wbox-cloud',
        namespace: 'default',
        labels: { id: '7' },
      },
      spec: {
        displayName: 'H52 WBox Cloud',
        description: '新版云端发布技能',
        version: '2.0.0',
        tags: ['wbox'],
      },
      status: { state: 'Available' },
    })
  })

  it('changes a marketplace skill to selected teams', async () => {
    const user = userEvent.setup()
    render(<PublishedResources resourceType="skill" />)

    expect(await screen.findByTestId('published-resource-card-7')).toHaveTextContent(
      'h52wbox-cloud'
    )
    expect(screen.getByText('已发布')).toHaveClass('whitespace-nowrap')
    expect(screen.getByText('市场')).toBeInTheDocument()
    expect(screen.getByTestId('published-resource-footer-7')).toHaveTextContent(
      'yansheng32026-07-28'
    )
    await user.click(screen.getByTestId('publication-more-actions-7'))

    expect(screen.getByTestId('publication-edit-scope-7')).toBeInTheDocument()
    expect(screen.getByTestId('publication-status-7')).toHaveTextContent('归档')

    await user.click(screen.getByTestId('publication-edit-scope-7'))
    expect(await screen.findByTestId('publication-settings-dialog')).toBeInTheDocument()
    await user.click(screen.getByTestId('capability-scope-team'))
    await user.click(screen.getByTestId('capability-scope-group-team-a'))
    await user.click(screen.getByTestId('publication-settings-save'))

    await waitFor(() =>
      expect(mockResourceLibraryApi.updatePublication).toHaveBeenCalledWith(7, {
        status: 'archived',
        allow_personal_install: false,
        allow_group_install: true,
        target_groups: ['team-a'],
      })
    )
  })

  it('publishes an agent to selected teams by reference', async () => {
    mockResourceLibraryApi.listMyPublished.mockResolvedValueOnce({
      items: [
        {
          id: 9,
          resource_type: 'agent',
          name: 'research-agent',
          display_name: 'Research Agent',
          description: 'Research assistant',
          tags: [],
          publisher_user_id: 1,
          status: 'published',
          current_version: {
            id: 9,
            version: '1.0.0',
            created_at: '2026-07-28T00:00:00Z',
          },
          install_count: 0,
          is_installed: false,
          bind_modes: ['chat'],
          allow_personal_install: true,
          allow_group_install: true,
          created_at: '2026-07-28T00:00:00Z',
          updated_at: '2026-07-28T00:00:00Z',
        },
      ],
      total: 1,
    })
    const user = userEvent.setup()

    render(<PublishedResources resourceType="agent" />)

    await user.click(await screen.findByTestId('publication-more-actions-9'))
    await user.click(screen.getByTestId('publication-edit-scope-9'))
    await user.click(screen.getByTestId('capability-scope-team'))
    await user.click(screen.getByTestId('capability-scope-group-team-a'))
    await user.click(screen.getByTestId('publication-settings-save'))

    await waitFor(() =>
      expect(mockResourceLibraryApi.updatePublication).toHaveBeenCalledWith(9, {
        status: 'archived',
        allow_personal_install: false,
        allow_group_install: true,
        target_groups: ['team-a'],
      })
    )
  })

  it('renders an unboxed empty state', async () => {
    mockResourceLibraryApi.listMyPublished.mockResolvedValueOnce({
      items: [],
      total: 0,
    })

    render(<PublishedResources resourceType="skill" />)

    const emptyState = await screen.findByTestId('published-resources-empty')
    expect(emptyState).not.toHaveClass('rounded-xl', 'border', 'bg-surface')
    expect(emptyState).toHaveClass('min-h-48')
  })

  it('uploads the source skill before publishing its new marketplace version', async () => {
    const user = userEvent.setup()
    render(<PublishedResources resourceType="skill" />)

    await screen.findByTestId('published-resource-card-7')
    await user.click(screen.getByTestId('publication-more-actions-7'))
    expect(screen.getByTestId('publication-publish-version-7')).toHaveTextContent(
      '编辑并发布新版本'
    )
    await user.click(screen.getByTestId('publication-publish-version-7'))

    expect(mockedGetSkill).toHaveBeenCalledWith(7)
    await user.click(await screen.findByTestId('complete-skill-version-upload'))

    await waitFor(() =>
      expect(mockResourceLibraryApi.updatePublication).toHaveBeenCalledWith(7, {
        display_name: 'H52 WBox Cloud',
        description: '新版云端发布技能',
        tags: ['wbox'],
        version: '2.0.0',
        status: 'published',
      })
    )
  })
})
