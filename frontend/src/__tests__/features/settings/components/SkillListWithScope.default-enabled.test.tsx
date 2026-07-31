// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { HTMLAttributes, ReactNode } from 'react'
import {
  addSkillToMyDefault,
  batchUpdateSkillsFromGit,
  deleteSkill,
  downloadSkill,
  fetchMyDefaultSkillBindings,
  fetchSkillReferences,
  fetchUnifiedSkillsList,
  parseSkillReferenceError,
  removeSingleSkillReference,
  removeSkillFromMyDefault,
  removeSkillReferences,
  updateMyDefaultSkillBindingExceptions,
  updateSkillFromGit,
} from '@/apis/skills'
import { checkSkillMarketAvailable } from '@/apis/skillMarket'
import { getGroup } from '@/apis/groups'
import { SkillListWithScope } from '@/features/settings/components/SkillListWithScope'
import type { UnifiedSkill } from '@/apis/skills'
import { fetchTeamsList } from '@/features/settings/services/teams'

jest.mock('@/apis/skills', () => ({
  addSkillToMyDefault: jest.fn(),
  batchUpdateSkillsFromGit: jest.fn(),
  deleteSkill: jest.fn(),
  downloadSkill: jest.fn(),
  fetchMyDefaultSkillBindings: jest.fn(),
  fetchSkillReferences: jest.fn(),
  fetchUnifiedSkillsList: jest.fn(),
  parseSkillReferenceError: jest.fn(),
  removeSingleSkillReference: jest.fn(),
  removeSkillFromMyDefault: jest.fn(),
  removeSkillReferences: jest.fn(),
  updateMyDefaultSkillBindingExceptions: jest.fn(),
  updateSkillFromGit: jest.fn(),
}))

jest.mock('@/apis/skillMarket', () => ({
  checkSkillMarketAvailable: jest.fn(),
}))

jest.mock('@/apis/groups', () => ({
  getGroup: jest.fn(),
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({ user: { id: 1, user_name: 'yansheng3', role: 'user' } }),
}))

jest.mock('@/features/settings/services/teams', () => ({
  fetchTeamsList: jest.fn(),
}))

jest.mock('@/components/ui/drawer', () => ({
  Drawer: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DrawerContent: ({
    children,
    showHandle: _showHandle,
    ...props
  }: HTMLAttributes<HTMLDivElement> & { showHandle?: boolean }) => (
    <div role="dialog" {...props}>
      {children}
    </div>
  ),
  DrawerHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DrawerDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DrawerFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/features/settings/components/skills/SkillUploadModal', () => {
  function MockSkillUploadModal({
    open,
    onClose,
    skill,
  }: {
    open: boolean
    onClose: (saved: boolean, skillId?: number) => void
    skill?: UnifiedSkill | null
  }) {
    return open ? (
      <div data-testid="skill-upload-modal" data-editing-skill={skill?.name || ''}>
        <button type="button" data-testid="cancel-skill-upload" onClick={() => onClose(false)}>
          Cancel upload
        </button>
      </div>
    ) : null
  }

  return MockSkillUploadModal
})

jest.mock('@/features/settings/components/skills/SkillSearchModal', () => {
  function MockSkillSearchModal() {
    return null
  }

  return MockSkillSearchModal
})

jest.mock('@/features/settings/components/skills/SkillReferenceConflictDialog', () => ({
  SkillReferenceConflictDialog: () => null,
}))

const translations: Record<string, string> = {
  'actions.delete': '删除',
  'actions.download': '下载',
  'resource-library:actions.edit_skill': '编辑技能',
  'skills.defaultEnabled.title': '自动启用技能',
  'skills.defaultEnabled.description':
    '这些技能会在你的所有对话中自动生效；也可以为模式或智能体设置例外。',
  'skills.defaultEnabled.add': '添加',
  'skills.defaultEnabled.settings': '管理',
  'skills.defaultEnabled.summaryCount': '{{count}} 个已启用',
  'skills.defaultEnabled.overflowCount': '+{{count}}',
  'skills.defaultEnabled.addDialogTitle': '添加自动启用技能',
  'skills.defaultEnabled.addDialogDescription': '从你可用的所有技能中选择要自动启用的技能。',
  'skills.defaultEnabled.noAvailableToAdd': '没有可添加的技能。',
  'skills.defaultEnabled.emptyTitle': '还没有自动启用的技能',
  'skills.defaultEnabled.emptyDescription':
    '从技能库中把技能设为自动启用后，它会自动加入你的对话。',
  'skills.libraryTitle': '技能库',
  'skills.libraryDescription':
    '上传、管理技能。技能可以设为自动启用，跟随你进入对话；也可以在智能体里添加技能，强化智能体的能力。',
  'skills.myLibraryTitle': '我的技能',
  'skills.myLibraryDescription': '管理你创建和已启用的技能。',
  'skills.availability.inMyDefault': '自动启用',
  'skills.availability.addToMyDefault': '设为自动启用',
  'skills.availability.removeFromMyDefault': '取消自动启用',
  'skills.availability.removeSuccess': '已取消自动启用',
  'skills.availability.removeExternalSuccess': '已取消自动启用，可在“发现”中重新添加',
  'skills.source.personal': '我的技能',
  'skills.source.group': '团队技能',
  'skills.source.system': '系统技能',
  'skills.autoSettings.title': '自动启用设置',
  'skills.autoSettings.description': '按技能管理自动启用的例外场景。',
  'skills.autoSettings.back': '返回技能库',
  'skills.autoSettings.allConversations': '所有对话自动启用',
  'skills.autoSettings.exceptionCount': '有 {{count}} 个例外',
  'skills.autoSettings.noExceptions': '没有例外',
  'skills.autoSettings.skillColumn': '技能',
  'skills.autoSettings.modeColumn': '启用模式',
  'skills.autoSettings.agentColumn': '启用智能体',
  'skills.autoSettings.exceptionColumn': '例外',
  'skills.autoSettings.actionColumn': '操作',
  'skills.autoSettings.configure': '配置',
  'skills.autoSettings.configureSkill': '配置 {{name}}',
  'skills.autoSettings.allModesEnabled': '全部模式',
  'skills.autoSettings.enabledModeCount': '启用 {{enabled}}/{{total}} 个模式',
  'skills.autoSettings.allAgentsEnabled': '全部智能体',
  'skills.autoSettings.enabledAgentCount': '启用 {{enabled}}/{{total}} 个智能体',
  'skills.autoSettings.noAgentsAvailable': '没有可用智能体',
  'skills.autoSettings.modeExceptions': '启用的模式',
  'skills.autoSettings.agentExceptions': '启用的智能体',
  'skills.autoSettings.drawerDescription': '这些例外只影响你自己的自动启用设置。',
  'skills.autoSettings.defaultScopeTitle': '默认自动启用',
  'skills.autoSettings.defaultScopeDescription':
    '默认对所有模式和智能体启用；取消勾选的项目会成为例外。',
  'skills.autoSettings.forcePreload': '强制激活',
  'skills.autoSettings.forcePreloadDescription':
    '打开后，这个技能会直接进入上下文，不等待模型按需加载。',
  'skills.autoSettings.forcePreloadDisabled': '按需加载',
  'skills.autoSettings.modeEnableLabel': '启用{{mode}}模式',
  'skills.autoSettings.agentEnableLabel': '启用 {{name}}',
  'skills.autoSettings.agentGroupEnableLabel': '启用所有{{group}}',
  'skills.autoSettings.agentGroups.personal': '我的智能体',
  'skills.autoSettings.agentGroups.group': '团队智能体',
  'skills.autoSettings.agentGroups.system': '系统智能体',
  'skills.autoSettings.emptyAgentGroup': '没有智能体',
  'skills.autoSettings.clearExceptions': '恢复全部启用',
  'skills.autoSettings.save': '保存设置',
  'skills.autoSettings.saveSuccess': '自动启用设置已保存',
  'skills.autoSettings.saveFailed': '保存自动启用设置失败',
  'skills.autoSettings.modes.chat': '聊天',
  'skills.autoSettings.modes.code': '代码',
  'skills.autoSettings.modes.knowledge': '知识库',
  'skills.autoSettings.modes.task': '任务',
  'skills.autoSettings.modes.video': '视频',
  'skills.autoSettings.modes.image': '图片',
}

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      let value = translations[key] ?? key
      if (options) {
        for (const [optionKey, optionValue] of Object.entries(options)) {
          value = value.replace(`{{${optionKey}}}`, String(optionValue))
        }
      }
      return value
    },
  }),
}))

const mockedFetchUnifiedSkillsList = fetchUnifiedSkillsList as jest.Mock
const mockedCheckSkillMarketAvailable = checkSkillMarketAvailable as jest.Mock
const mockedAddSkillToMyDefault = addSkillToMyDefault as jest.Mock
const mockedRemoveSkillFromMyDefault = removeSkillFromMyDefault as jest.Mock
const mockedFetchMyDefaultSkillBindings = fetchMyDefaultSkillBindings as jest.Mock
const mockedUpdateMyDefaultSkillBindingExceptions =
  updateMyDefaultSkillBindingExceptions as jest.Mock
const mockedFetchTeamsList = fetchTeamsList as jest.Mock
const mockedGetGroup = getGroup as jest.Mock

function buildSkill(overrides: Partial<UnifiedSkill>): UnifiedSkill {
  return {
    id: overrides.id ?? 1,
    name: overrides.name ?? 'skill',
    namespace: overrides.namespace ?? 'default',
    description: overrides.description ?? 'Skill description',
    displayName: overrides.displayName,
    version: overrides.version,
    author: overrides.author,
    tags: overrides.tags,
    bindShells: overrides.bindShells,
    visible: overrides.visible,
    is_active: overrides.is_active ?? true,
    is_public: overrides.is_public ?? false,
    user_id: overrides.user_id ?? 1,
    availability: overrides.availability,
    source: overrides.source,
    created_at: overrides.created_at,
    updated_at: overrides.updated_at,
  }
}

describe('SkillListWithScope default enabled skills', () => {
  beforeEach(() => {
    mockedFetchUnifiedSkillsList.mockImplementation(async params => {
      if (params?.scope === 'all') {
        return [
          buildSkill({
            id: 1,
            name: 'default-enabled-skill',
            displayName: 'Default Enabled Skill',
            availability: { inMyDefault: true },
          }),
          buildSkill({
            id: 2,
            name: 'library-skill',
            displayName: 'Library Skill',
          }),
        ]
      }

      return [
        buildSkill({
          id: 1,
          name: 'default-enabled-skill',
          displayName: 'Default Enabled Skill',
          availability: { inMyDefault: true },
        }),
        buildSkill({
          id: 2,
          name: 'library-skill',
          displayName: 'Library Skill',
        }),
      ]
    })
    mockedCheckSkillMarketAvailable.mockResolvedValue({ available: false })
    mockedRemoveSkillFromMyDefault.mockResolvedValue(undefined)
    mockedAddSkillToMyDefault.mockImplementation(async skillId => ({
      id: 90,
      target_type: 'user',
      target_id: 'user:1',
      skill_ref: {
        skill_id: skillId,
        name: 'default-enabled-skill',
        namespace: 'default',
        is_public: false,
      },
      exceptions: [],
    }))
    mockedFetchMyDefaultSkillBindings.mockResolvedValue([
      {
        id: 90,
        target_type: 'user',
        target_id: 'user:1',
        skill_ref: {
          skill_id: 1,
          name: 'default-enabled-skill',
          namespace: 'default',
          is_public: false,
        },
        exceptions: [],
        force_preload: false,
      },
    ])
    mockedUpdateMyDefaultSkillBindingExceptions.mockImplementation(
      async (skillId, exceptions, forcePreload) => ({
        id: 90,
        target_type: 'user',
        target_id: 'user:1',
        skill_ref: {
          skill_id: skillId,
          name: 'default-enabled-skill',
          namespace: 'default',
          is_public: false,
        },
        exceptions,
        force_preload: forcePreload ?? false,
      })
    )
    mockedFetchTeamsList.mockResolvedValue([
      {
        id: 99,
        name: 'my-helper',
        displayName: 'My Helper',
        namespace: 'default',
        description: 'My helper agent',
        bots: [],
        workflow: {},
        is_active: true,
        user_id: 1,
        created_at: '',
        updated_at: '',
      },
      {
        id: 100,
        name: 'system-chat',
        displayName: 'System Chat',
        namespace: 'default',
        description: 'System chat agent',
        bots: [],
        workflow: {},
        is_active: true,
        user_id: 0,
        created_at: '',
        updated_at: '',
      },
      {
        id: 101,
        name: 'team-coder',
        displayName: 'Team Coder',
        namespace: 'platform',
        description: 'Team coding agent',
        bots: [],
        workflow: {},
        is_active: true,
        user_id: 2,
        created_at: '',
        updated_at: '',
      },
    ])
    ;(batchUpdateSkillsFromGit as jest.Mock).mockResolvedValue({
      total_success: 0,
      total_failed: 0,
      total_skipped: 0,
    })
    ;(deleteSkill as jest.Mock).mockResolvedValue(undefined)
    ;(downloadSkill as jest.Mock).mockResolvedValue(undefined)
    ;(fetchSkillReferences as jest.Mock).mockResolvedValue({ referenced_ghosts: [] })
    ;(parseSkillReferenceError as jest.Mock).mockReturnValue(null)
    ;(removeSingleSkillReference as jest.Mock).mockResolvedValue(undefined)
    ;(removeSkillReferences as jest.Mock).mockResolvedValue(undefined)
    ;(updateSkillFromGit as jest.Mock).mockResolvedValue(undefined)
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('keeps personal skills in the library with their auto-enable switch and configuration', async () => {
    const user = userEvent.setup()

    render(<SkillListWithScope scope="personal" compact />)

    const librarySection = await screen.findByTestId('skill-library-section')

    expect(
      within(librarySection).getByRole('heading', { level: 2, name: '我的技能' })
    ).toBeInTheDocument()
    expect(within(librarySection).getByText('管理你创建和已启用的技能。')).toBeInTheDocument()
    expect(within(librarySection).getByText('Default Enabled Skill')).toBeInTheDocument()
    expect(within(librarySection).getByText('Library Skill')).toBeInTheDocument()
    const personalCard = within(librarySection).getByTestId('skill-library-item-1')
    expect(within(personalCard).getByRole('switch', { name: '取消自动启用' })).toBeInTheDocument()

    await user.click(within(personalCard).getByTestId('skill-card-more-button-1'))
    await user.click(await screen.findByTestId('configure-personal-skill-1'))
    expect(await screen.findByRole('dialog', { name: 'Default Enabled Skill' })).toBeInTheDocument()
    await user.keyboard('{Escape}')

    await user.click(within(personalCard).getByTestId('remove-skill-default-button-1'))

    expect(mockedRemoveSkillFromMyDefault).toHaveBeenCalledWith(1)
    expect(within(librarySection).getByText('Default Enabled Skill')).toBeInTheDocument()
  })

  it('notifies the resource library when an external skill creation is cancelled', async () => {
    const user = userEvent.setup()
    const onCreateRequestClose = jest.fn()

    render(
      <SkillListWithScope
        scope="personal"
        createRequest={{
          id: 1,
          target: { scope: 'personal' },
          publishAfterCreate: false,
        }}
        onCreateRequestClose={onCreateRequestClose}
        creationOnly
      />
    )

    await user.click(await screen.findByTestId('cancel-skill-upload'))

    expect(onCreateRequestClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('cancel-skill-upload')).not.toBeInTheDocument()
  })

  it('keeps installed skills independent from the personal skill source filter', async () => {
    mockedFetchUnifiedSkillsList.mockImplementation(async params => {
      if (params?.scope === 'all') {
        return [
          buildSkill({
            id: 3,
            name: 'group-default-skill',
            displayName: 'Group Default Skill',
            namespace: 'platform',
            user_id: 1,
            availability: { inMyDefault: true },
          }),
          buildSkill({
            id: 4,
            name: 'personal-library-skill',
            displayName: 'Personal Library Skill',
          }),
        ]
      }

      return [
        buildSkill({
          id: 4,
          name: 'personal-library-skill',
          displayName: 'Personal Library Skill',
          updated_at: '2026-07-29T00:00:00Z',
        }),
      ]
    })

    render(<SkillListWithScope scope="personal" compact />)

    const librarySection = await screen.findByTestId('skill-library-section')

    expect(mockedFetchUnifiedSkillsList).toHaveBeenCalledWith({ scope: 'all' })
    expect(mockedFetchUnifiedSkillsList).toHaveBeenCalledWith({
      scope: 'personal',
      groupName: undefined,
    })
    expect(within(librarySection).getByText('Group Default Skill')).toBeInTheDocument()
    expect(within(librarySection).getByTestId('installed-skill-card-3')).toHaveClass(
      'min-h-[180px]',
      'rounded-xl',
      'p-4'
    )
    expect(within(librarySection).getByText('Personal Library Skill')).toBeInTheDocument()
    expect(within(librarySection).getByTestId('skill-library-item-4')).toHaveClass('min-h-[180px]')
    expect(within(librarySection).getByTestId('skill-card-footer-4')).toHaveTextContent(
      'yansheng32026-07-29'
    )
  })

  it('uses a responsive card grid in compact resource-library views', async () => {
    const user = userEvent.setup()
    render(<SkillListWithScope scope="personal" compact showAutoEnabledSkills={false} />)

    const list = await screen.findByTestId('skill-library-list')
    expect(list).toHaveClass(
      'grid',
      'grid-cols-1',
      'sm:grid-cols-2',
      'lg:grid-cols-3',
      'xl:grid-cols-4'
    )
    const [card] = within(list).getAllByTestId(/^skill-library-item-/)
    expect(card).toHaveClass('min-h-[180px]', 'gap-3')
    expect(within(card).getByTestId('resource-card-icon')).toHaveClass(
      'h-11',
      'w-11',
      'rounded-xl',
      'border'
    )
    expect(within(card).queryByTestId('skill-card-actions-1')).not.toBeInTheDocument()
    expect(card).toHaveClass('group')
    const moreButton = within(card).getByTestId('skill-card-more-button-1')
    expect(moreButton).toHaveClass(
      'h-11',
      'w-11',
      'opacity-100',
      'md:h-7',
      'md:w-7',
      'md:opacity-0',
      'md:group-hover:opacity-100',
      'md:group-focus-within:opacity-100'
    )
    const autoEnableSwitch = within(card).getByRole('switch')
    expect(
      moreButton.compareDocumentPosition(autoEnableSwitch) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    await user.click(moreButton)
    expect(await screen.findByTestId('edit-skill-button-1')).toBeInTheDocument()
    expect(screen.getByText('编辑技能')).toBeInTheDocument()
    expect(await screen.findByTestId('download-skill-button-1')).toBeInTheDocument()
    expect(screen.getByText('下载')).toBeInTheDocument()
    expect(screen.getByTestId('view-skill-references-button-1')).toBeInTheDocument()
    expect(screen.getByTestId('delete-skill-button-1')).toBeInTheDocument()
    expect(screen.getByText('删除')).toBeInTheDocument()
    expect(screen.getByText('技能库')).toBeInTheDocument()
  })

  it('opens an existing personal skill in the shared editor', async () => {
    const user = userEvent.setup()
    render(<SkillListWithScope scope="personal" compact showAutoEnabledSkills={false} />)

    const card = await screen.findByTestId('skill-library-item-1')
    await user.click(within(card).getByTestId('skill-card-more-button-1'))
    await user.click(await screen.findByTestId('edit-skill-button-1'))

    expect(screen.getByTestId('skill-upload-modal')).toHaveAttribute(
      'data-editing-skill',
      'default-enabled-skill'
    )
  })

  it('keeps compact skill metadata concise', async () => {
    mockedFetchUnifiedSkillsList.mockResolvedValue([
      buildSkill({
        id: 9,
        name: 'dense-skill',
        displayName: 'Dense Skill',
        version: '2.0.0',
        is_public: false,
        user_id: 0,
        tags: ['automation', 'scheduler', 'subscription', 'report'],
      }),
    ])

    render(<SkillListWithScope scope="all" compact showAutoEnabledSkills={false} />)

    const card = await screen.findByTestId('skill-library-item-9')
    expect(within(card).getByText('系统技能')).toBeInTheDocument()
    expect(within(card).getByText('v2.0.0')).toHaveClass('text-text-muted')
    expect(within(card).getByText('automation')).toBeInTheDocument()
    expect(within(card).getByText('scheduler')).toBeInTheDocument()
    expect(within(card).getByText('+2')).toBeInTheDocument()
    expect(within(card).queryByText('subscription')).not.toBeInTheDocument()
    expect(within(card).queryByText('report')).not.toBeInTheDocument()
    expect(within(card).queryByText('自动启用')).not.toBeInTheDocument()
    expect(within(card).getByRole('switch', { name: '设为自动启用' })).toBeInTheDocument()
    expect(within(card).queryByTestId('skill-card-more-button-9')).not.toBeInTheDocument()
    expect(within(card).queryByTestId('skill-card-actions-9')).not.toBeInTheDocument()
  })

  it('right-aligns skill library sort controls in compact resource-library views', async () => {
    render(
      <SkillListWithScope
        scope="personal"
        compact
        showAutoEnabledSkills={false}
        sortControls={<div data-testid="test-sort-control">排序</div>}
      />
    )

    const sortSlot = await screen.findByTestId('skill-library-sort-controls')
    expect(sortSlot).toHaveClass('justify-end', 'lg:ml-auto')
    expect(within(sortSlot).getByTestId('test-sort-control')).toBeInTheDocument()
  })

  it('removes an external skill by disabling it from the card switch', async () => {
    const user = userEvent.setup()
    mockedFetchUnifiedSkillsList.mockImplementation(async params => {
      if (params?.scope === 'all') {
        return [
          buildSkill({
            id: 5,
            name: 'installed-group-skill',
            displayName: 'Installed Group Skill',
            namespace: 'platform',
            user_id: 2,
            availability: { inMyDefault: true },
          }),
        ]
      }

      return []
    })

    render(<SkillListWithScope scope="personal" />)

    const librarySection = await screen.findByTestId('skill-library-section')
    const card = within(librarySection).getByTestId('installed-skill-card-5')
    const moreButton = within(card).getByTestId('installed-skill-more-button-5')
    const autoEnableSwitch = within(card).getByRole('switch', { name: '取消自动启用' })
    expect(
      moreButton.compareDocumentPosition(autoEnableSwitch) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    await user.click(autoEnableSwitch)

    expect(mockedRemoveSkillFromMyDefault).toHaveBeenCalledWith(5)
    await waitFor(() => {
      expect(within(librarySection).queryByTestId('installed-skill-card-5')).not.toBeInTheDocument()
    })
  })

  it('opens an installed skill configuration directly and saves mode and agent selections', async () => {
    const user = userEvent.setup()
    mockedFetchUnifiedSkillsList.mockImplementation(async params => {
      if (params?.scope === 'all') {
        return [
          buildSkill({
            id: 1,
            name: 'default-enabled-skill',
            displayName: 'Default Enabled Skill',
            user_id: 2,
            availability: { inMyDefault: true },
          }),
        ]
      }
      return []
    })
    mockedFetchMyDefaultSkillBindings.mockResolvedValue([
      {
        id: 91,
        target_type: 'user',
        target_id: 'user:1',
        skill_ref: {
          skill_id: 1,
          name: 'default-enabled-skill',
          namespace: 'default',
          is_public: false,
        },
        exceptions: [{ type: 'mode', value: 'code' }],
        force_preload: false,
      },
    ])

    render(<SkillListWithScope scope="personal" />)

    const librarySection = await screen.findByTestId('skill-library-section')
    await user.click(within(librarySection).getByTestId('installed-skill-more-button-1'))
    await user.click(await screen.findByTestId('configure-installed-skill-1'))

    expect(screen.queryByTestId('auto-enabled-settings-view')).not.toBeInTheDocument()
    expect(librarySection).toBeInTheDocument()
    const dialog = await screen.findByRole('dialog', { name: 'Default Enabled Skill' })
    expect(await screen.findByText('默认自动启用')).toBeInTheDocument()
    expect(
      screen.getByText('默认对所有模式和智能体启用；取消勾选的项目会成为例外。')
    ).toBeInTheDocument()
    expect(within(dialog).getByText('启用的模式')).toBeInTheDocument()
    expect(within(dialog).getByText('我的智能体')).toBeInTheDocument()
    expect(within(dialog).getByText('团队智能体')).toBeInTheDocument()
    expect(within(dialog).getByText('系统智能体')).toBeInTheDocument()

    const forcePreloadSwitch = within(dialog).getByRole('switch', { name: '强制激活' })
    const codeCheckbox = within(dialog).getByRole('checkbox', { name: '启用代码模式' })
    const chatCheckbox = within(dialog).getByRole('checkbox', { name: '启用聊天模式' })
    const teamGroupCheckbox = within(dialog).getByRole('checkbox', {
      name: '启用所有团队智能体',
    })
    const systemAgentCheckbox = within(dialog).getByRole('checkbox', {
      name: '启用 System Chat',
    })
    expect(codeCheckbox).not.toBeChecked()
    expect(chatCheckbox).toBeChecked()
    expect(forcePreloadSwitch).not.toBeChecked()
    expect(teamGroupCheckbox).toBeChecked()
    expect(systemAgentCheckbox).toBeChecked()

    await user.click(forcePreloadSwitch)
    await user.click(chatCheckbox)
    await user.click(teamGroupCheckbox)
    await user.click(systemAgentCheckbox)
    expect(within(dialog).getByRole('checkbox', { name: '启用 Team Coder' })).not.toBeChecked()
    expect(systemAgentCheckbox).not.toBeChecked()
    await user.click(within(dialog).getByRole('button', { name: '保存设置' }))

    await waitFor(() => {
      expect(mockedUpdateMyDefaultSkillBindingExceptions).toHaveBeenCalledWith(
        1,
        [
          { type: 'mode', value: 'code' },
          { type: 'mode', value: 'chat' },
          { type: 'agent', value: '101' },
          { type: 'agent', value: '100' },
        ],
        true
      )
    })
    expect(screen.queryByRole('dialog', { name: 'Default Enabled Skill' })).not.toBeInTheDocument()
  }, 10000)

  it('loads force activation in the direct personal skill configuration', async () => {
    const user = userEvent.setup()
    mockedFetchMyDefaultSkillBindings.mockResolvedValue([
      {
        id: 91,
        target_type: 'user',
        target_id: 'user:1',
        skill_ref: {
          skill_id: 1,
          name: 'default-enabled-skill',
          namespace: 'default',
          is_public: false,
        },
        exceptions: [],
        force_preload: true,
      },
    ])

    render(<SkillListWithScope scope="personal" compact />)

    const personalCard = await screen.findByTestId('skill-library-item-1')
    await user.click(within(personalCard).getByTestId('skill-card-more-button-1'))
    await user.click(await screen.findByTestId('configure-personal-skill-1'))

    const dialog = await screen.findByRole('dialog', { name: 'Default Enabled Skill' })
    expect(within(dialog).getByRole('switch', { name: '强制激活' })).toBeChecked()
    expect(screen.queryByRole('columnheader')).not.toBeInTheDocument()
  })

  it('keeps the source filter inside the skill library and applies it only to library items', async () => {
    mockedFetchUnifiedSkillsList.mockResolvedValue([
      buildSkill({
        id: 6,
        name: 'group-default-skill',
        displayName: 'Group Default Skill',
        namespace: 'platform',
        user_id: 2,
        availability: { inMyDefault: true },
      }),
      buildSkill({
        id: 7,
        name: 'personal-skill',
        displayName: 'Personal Skill',
      }),
      buildSkill({
        id: 8,
        name: 'system-skill',
        displayName: 'System Skill',
        is_public: true,
        user_id: 0,
      }),
    ])

    render(
      <SkillListWithScope
        scope="all"
        sourceFilter="system"
        sourceControls={<div data-testid="source-controls">来源筛选</div>}
      />
    )

    const librarySection = await screen.findByTestId('skill-library-section')

    expect(within(librarySection).getByTestId('resource-page-filter-bar')).toBeInTheDocument()
    expect(within(librarySection).getByTestId('source-controls')).toBeInTheDocument()
    expect(within(librarySection).getByText('Group Default Skill')).toBeInTheDocument()
    expect(within(librarySection).getByText('System Skill')).toBeInTheDocument()
    expect(within(librarySection).queryByText('Personal Skill')).not.toBeInTheDocument()
  })

  it('shows edit and download actions to a group developer without delete access', async () => {
    const user = userEvent.setup()
    mockedGetGroup.mockResolvedValue({
      id: 9,
      name: 'platform',
      display_name: 'Platform',
      my_role: 'Developer',
    })
    mockedFetchUnifiedSkillsList.mockResolvedValue([
      buildSkill({
        id: 20,
        name: 'group-skill',
        displayName: 'Group Skill',
        namespace: 'platform',
        user_id: 2,
      }),
    ])

    render(<SkillListWithScope scope="group" selectedGroup="platform" compact />)

    const card = await screen.findByTestId('skill-library-item-20')
    await user.click(within(card).getByTestId('skill-card-more-button-20'))

    expect(await screen.findByTestId('edit-skill-button-20')).toBeInTheDocument()
    expect(screen.getByTestId('download-skill-button-20')).toBeInTheDocument()
    expect(screen.queryByTestId('delete-skill-button-20')).not.toBeInTheDocument()
  })
})
