// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'

import { resourceLibraryApi } from '@/apis/resourceLibrary'
import { fetchMyDefaultSkillBindings, removeSkillFromMyDefault } from '@/apis/skills'
import { InstalledResources } from '@/features/resource-library/components/InstalledResources'
import type {
  ResourceLibraryInstall,
  ResourceLibraryListing,
} from '@/features/resource-library/types'

const mockPush = jest.fn()
const mockToast = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

jest.mock('@/apis/resourceLibrary', () => ({
  resourceLibraryApi: {
    listMyInstalls: jest.fn(),
    listGroupInstallsBatch: jest.fn(),
    uninstallListing: jest.fn(),
  },
}))

jest.mock('@/apis/skills', () => ({
  fetchMyDefaultSkillBindings: jest.fn(),
  removeSkillFromMyDefault: jest.fn(),
}))

jest.mock('@/features/settings/components/skills/AutoEnabledSkillConfigDialog', () => ({
  AutoEnabledSkillConfigDialog: ({
    open,
    skill,
  }: {
    open: boolean
    skill: { id: number } | null
  }) => (open ? <div data-testid="added-skill-config-dialog" data-skill-id={skill?.id} /> : null),
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => {
      const translation =
        {
          'filters.agent': '智能体',
          'filters.skill': '技能',
          'actions.use': '去使用',
          'actions.use_now': '立即使用',
          'actions.open_chat': '去对话',
          'actions.open_code': '去编码',
          'actions.add': '添加',
          'actions.added': '已添加',
          'actions.details': '详情',
          'actions.more': '更多操作',
          'actions.remove_added_agent': '取消添加',
          'actions.remove_added_skill': '取消添加',
          'actions.cancel': '取消',
          'actions.retry': '重试',
          'skills.autoSettings.configure': '配置',
          'fields.publisher': '发布者',
          'fields.official_publisher': 'Wegent 官方',
          'fields.updated_at': '更新时间',
          'common:teams.go_to_chat': '去聊天',
          'common:teams.go_to_code': '去编码',
          'states.loading': '正在加载资源',
          'states.empty': '暂无资源',
          'states.error': '加载失败',
          'messages.remove_added_skill_success': '已取消添加技能',
          'messages.remove_added_skill_failed': '取消添加技能失败',
          'messages.remove_added_skill_confirm': '确定取消添加技能「{{skill}}」吗？',
          'messages.remove_added_agent_success': '已取消添加智能体',
          'messages.remove_added_agent_failed': '取消添加智能体失败',
          'messages.remove_added_agent_confirm': '确定取消添加智能体「{{agent}}」吗？',
        }[key] ?? key

      return Object.entries(values || {}).reduce(
        (result, [name, value]) => result.replace(`{{${name}}}`, value),
        translation
      )
    },
  }),
}))

jest.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <>{children}</> : null,
  AlertDialogContent: ({ children }: { children: ReactNode }) => (
    <div role="alertdialog">{children}</div>
  ),
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  AlertDialogAction: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <>{children}</> : null,
  DialogContent: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => (
    <div role="dialog" {...props}>
      {children}
    </div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

jest.mock('@/components/ui/dropdown', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
    'data-testid': testId,
  }: {
    children: ReactNode
    onSelect?: () => void
    disabled?: boolean
    'data-testid'?: string
  }) => (
    <button type="button" onClick={onSelect} disabled={disabled} data-testid={testId}>
      {children}
    </button>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

const mockedListMyInstalls = resourceLibraryApi.listMyInstalls as jest.MockedFunction<
  typeof resourceLibraryApi.listMyInstalls
>
const mockedListGroupInstallsBatch =
  resourceLibraryApi.listGroupInstallsBatch as jest.MockedFunction<
    typeof resourceLibraryApi.listGroupInstallsBatch
  >
const mockedUninstallListing = resourceLibraryApi.uninstallListing as jest.MockedFunction<
  typeof resourceLibraryApi.uninstallListing
>
const mockedRemoveSkillFromMyDefault = removeSkillFromMyDefault as jest.MockedFunction<
  typeof removeSkillFromMyDefault
>
const mockedFetchMyDefaultSkillBindings = fetchMyDefaultSkillBindings as jest.MockedFunction<
  typeof fetchMyDefaultSkillBindings
>

function makeListing(
  resourceType: 'agent' | 'skill',
  overrides: Partial<ResourceLibraryListing> = {}
): ResourceLibraryListing {
  return {
    id: 92,
    resource_type: resourceType,
    name: `${resourceType}-resource`,
    display_name: resourceType === 'agent' ? 'Installed Agent' : 'Installed Skill',
    description: 'Installed resource description',
    tags: [],
    publisher_user_id: 2,
    publisher_user_name: 'publisher-user',
    status: 'published',
    install_count: 5,
    is_installed: false,
    bind_modes: resourceType === 'agent' ? ['chat'] : [],
    created_at: '2026-07-29T00:00:00Z',
    updated_at: '2026-07-29T00:00:00Z',
    ...overrides,
  }
}

function makeInstall(
  resourceType: 'agent' | 'skill',
  overrides: Partial<ResourceLibraryInstall> = {}
): ResourceLibraryInstall {
  const listing = makeListing(resourceType)
  return {
    id: 21,
    listing_id: listing.id,
    version_id: 1,
    user_id: 1,
    resource_type: resourceType,
    listing,
    installed_reference: resourceType === 'agent' ? { team_id: 128 } : { skill_id: listing.id },
    install_status: 'installed',
    installed_at: '2026-07-29T00:00:00Z',
    updated_at: '2026-07-29T00:00:00Z',
    ...overrides,
  }
}

async function openRemovalConfirmation(resourceType: 'agent' | 'skill', installId: number = 21) {
  fireEvent.click(
    await screen.findByTestId(`installed-resource-actions-${resourceType}-${installId}`)
  )
  fireEvent.click(await screen.findByTestId(`remove-installed-${resourceType}-${installId}-button`))
}

describe('InstalledResources', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedUninstallListing.mockResolvedValue()
    mockedRemoveSkillFromMyDefault.mockResolvedValue()
    mockedFetchMyDefaultSkillBindings.mockResolvedValue([
      {
        id: 31,
        target_type: 'user',
        target_id: '1',
        skill_ref: {
          skill_id: 92,
          name: 'skill-resource',
          namespace: 'default',
          is_public: true,
        },
        exceptions: [],
      },
    ])
    mockedListMyInstalls.mockResolvedValue({
      items: [makeInstall('skill')],
      total: 1,
      page: 1,
      limit: 100,
    })
    mockedListGroupInstallsBatch.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      limit: 100,
    })
  })

  it('loads installed listings, filters invalid installs, and shows personal removal', async () => {
    mockedListMyInstalls.mockResolvedValue({
      items: [
        makeInstall('skill'),
        makeInstall('skill', {
          id: 22,
          listing: makeListing('skill', { id: 93, display_name: 'Removed Skill' }),
          install_status: 'removed',
        }),
        makeInstall('skill', { id: 23, listing: undefined }),
      ],
      total: 3,
      page: 1,
      limit: 100,
    })

    render(<InstalledResources resourceType="skill" keyword="  installed  " />)

    expect(await screen.findByText('Installed Skill')).toBeInTheDocument()
    expect(mockedListMyInstalls).toHaveBeenCalledWith({
      resourceType: 'skill',
      page: 1,
      limit: 100,
    })
    expect(screen.queryByText('Removed Skill')).not.toBeInTheDocument()
    expect(screen.getByTestId('installed-resources-grid')).toHaveClass(
      'grid-cols-1',
      'content-start',
      'lg:grid-cols-3',
      'xl:grid-cols-4'
    )
    const footerAction = screen.getByTestId('resource-listing-footer-action-92')
    expect(within(footerAction).getByTestId('configure-added-skill-21-button')).toHaveTextContent(
      '配置'
    )
    expect(
      within(footerAction).getByTestId('installed-resource-actions-skill-21')
    ).toHaveAccessibleName('更多操作')
    expect(screen.queryByTestId('resource-listing-footer-92')).not.toBeInTheDocument()
  })

  it('opens configuration for a personal added skill from the card footer', async () => {
    render(<InstalledResources resourceType="skill" />)

    fireEvent.click(await screen.findByTestId('configure-added-skill-21-button'))

    expect(screen.getByTestId('added-skill-config-dialog')).toHaveAttribute('data-skill-id', '92')
  })

  it('loads every page of personal installs', async () => {
    mockedListMyInstalls.mockImplementation(params => {
      const page = params?.page || 1
      const listingId = page === 1 ? 201 : 202

      return Promise.resolve({
        items: [
          makeInstall('skill', {
            id: listingId,
            listing_id: listingId,
            listing: makeListing('skill', {
              id: listingId,
              display_name: page === 1 ? 'Personal Page One' : 'Personal Page Two',
            }),
          }),
        ],
        total: 2,
        page,
        limit: 100,
      })
    })

    render(<InstalledResources resourceType="skill" />)

    expect(await screen.findByText('Personal Page Two')).toBeInTheDocument()
    expect(screen.getByText('Personal Page One')).toBeInTheDocument()
    expect(mockedListMyInstalls).toHaveBeenNthCalledWith(1, {
      resourceType: 'skill',
      page: 1,
      limit: 100,
    })
    expect(mockedListMyInstalls).toHaveBeenNthCalledWith(2, {
      resourceType: 'skill',
      page: 2,
      limit: 100,
    })
  })

  it('removes a personal installed skill after confirmation', async () => {
    mockedListMyInstalls.mockResolvedValue({
      items: [
        makeInstall('skill', {
          installed_reference: { skill_id: 777 },
        }),
      ],
      total: 1,
      page: 1,
      limit: 100,
    })

    render(<InstalledResources resourceType="skill" />)

    await openRemovalConfirmation('skill')
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      '确定取消添加技能「Installed Skill」吗？'
    )
    fireEvent.click(screen.getByTestId('confirm-remove-installed-skill-button'))

    await waitFor(() => expect(mockedRemoveSkillFromMyDefault).toHaveBeenCalledWith(777))
    expect(screen.queryByTestId('resource-listing-card-92')).not.toBeInTheDocument()
    expect(mockToast).toHaveBeenCalledWith({ title: '已取消添加技能' })
  })

  it('falls back to the listing id when the installed skill reference has no id', async () => {
    mockedListMyInstalls.mockResolvedValue({
      items: [makeInstall('skill', { installed_reference: {} })],
      total: 1,
      page: 1,
      limit: 100,
    })

    render(<InstalledResources resourceType="skill" />)

    await openRemovalConfirmation('skill')
    fireEvent.click(screen.getByTestId('confirm-remove-installed-skill-button'))

    await waitFor(() => expect(mockedRemoveSkillFromMyDefault).toHaveBeenCalledWith(92))
  })

  it('keeps a personal installed skill when removal fails', async () => {
    mockedRemoveSkillFromMyDefault.mockRejectedValueOnce(new Error('remove failed'))

    render(<InstalledResources resourceType="skill" />)

    await openRemovalConfirmation('skill')
    fireEvent.click(screen.getByTestId('confirm-remove-installed-skill-button'))

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith({
        title: '取消添加技能失败',
        description: 'remove failed',
        variant: 'destructive',
      })
    )
    expect(screen.getByTestId('resource-listing-card-92')).toBeInTheDocument()
  })

  it('loads group installs, filters listing fields locally, and deduplicates listings', async () => {
    const nameMatch = makeInstall('skill', {
      id: 31,
      listing_id: 101,
      listing: makeListing('skill', {
        id: 101,
        name: 'needle-name',
        display_name: 'Name Match',
        description: 'First result',
      }),
    })
    const displayNameMatch = makeInstall('skill', {
      id: 32,
      listing_id: 102,
      listing: makeListing('skill', {
        id: 102,
        name: 'display-match',
        display_name: 'Needle Display',
        description: 'Second result',
      }),
    })
    const descriptionMatch = makeInstall('skill', {
      id: 33,
      listing_id: 103,
      listing: makeListing('skill', {
        id: 103,
        name: 'description-match',
        display_name: 'Description Match',
        description: 'Contains the needle in its description',
      }),
    })
    const unrelated = makeInstall('skill', {
      id: 34,
      listing_id: 104,
      listing: makeListing('skill', {
        id: 104,
        name: 'unrelated',
        display_name: 'Unrelated Skill',
        description: 'Does not match',
      }),
    })

    mockedListGroupInstallsBatch.mockResolvedValue({
      items: [
        nameMatch,
        displayNameMatch,
        makeInstall('skill', { ...nameMatch, id: 35 }),
        descriptionMatch,
        unrelated,
      ],
      total: 5,
      page: 1,
      limit: 100,
    })

    render(
      <InstalledResources
        resourceType="skill"
        keyword="  NEEDLE  "
        groupNamespaces={['engineering', 'product']}
      />
    )

    expect(await screen.findByText('Name Match')).toBeInTheDocument()
    expect(screen.getByText('Needle Display')).toBeInTheDocument()
    expect(screen.getByText('Description Match')).toBeInTheDocument()
    expect(screen.queryByText('Unrelated Skill')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('resource-listing-card-101')).toHaveLength(1)
    expect(mockedListMyInstalls).not.toHaveBeenCalled()
    expect(mockedListGroupInstallsBatch).toHaveBeenCalledTimes(1)
    expect(mockedListGroupInstallsBatch).toHaveBeenCalledWith(['engineering', 'product'], {
      resourceType: 'skill',
      page: 1,
      limit: 100,
    })
    expect(screen.queryByTestId('remove-installed-skill-31-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('resource-listing-management-actions-101')).not.toBeInTheDocument()
    const sharedSkillCard = screen.getByTestId('resource-listing-card-101')
    const detailButton = within(sharedSkillCard).getByTestId('view-shared-skill-31-button')
    expect(detailButton).toHaveTextContent('详情')
    expect(within(sharedSkillCard).queryByText('配置')).not.toBeInTheDocument()
    fireEvent.click(detailButton)
    expect(screen.getByTestId('resource-detail-dialog')).toBeInTheDocument()
  })

  it('keeps an empty group selection empty without loading personal installs', async () => {
    render(<InstalledResources resourceType="skill" groupNamespaces={[]} />)

    expect(await screen.findByTestId('installed-resources-empty')).toHaveTextContent('暂无资源')
    expect(mockedListGroupInstallsBatch).not.toHaveBeenCalled()
    expect(mockedListMyInstalls).not.toHaveBeenCalled()
  })

  it('loads every page of the selected group install sources in one batch', async () => {
    mockedListGroupInstallsBatch.mockImplementation((_groupNamespaces, params) => {
      const page = params?.page || 1
      const listingId = page === 1 ? 301 : 302

      return Promise.resolve({
        items: [
          makeInstall('skill', {
            id: listingId,
            listing_id: listingId,
            listing: makeListing('skill', {
              id: listingId,
              display_name: page === 1 ? 'Group Page One' : 'Group Page Two',
            }),
          }),
        ],
        total: 2,
        page,
        limit: 100,
      })
    })

    render(<InstalledResources resourceType="skill" groupNamespaces={['engineering']} />)

    expect(await screen.findByText('Group Page Two')).toBeInTheDocument()
    expect(screen.getByText('Group Page One')).toBeInTheDocument()
    expect(mockedListGroupInstallsBatch).toHaveBeenNthCalledWith(1, ['engineering'], {
      resourceType: 'skill',
      page: 1,
      limit: 100,
    })
    expect(mockedListGroupInstallsBatch).toHaveBeenNthCalledWith(2, ['engineering'], {
      resourceType: 'skill',
      page: 2,
      limit: 100,
    })
  })

  it('ignores stale results after the resource type and group selection change', async () => {
    let resolveStaleRequest: (
      value: Awaited<ReturnType<typeof resourceLibraryApi.listGroupInstallsBatch>>
    ) => void
    const currentInstall = makeInstall('agent', {
      id: 402,
      listing_id: 402,
      listing: makeListing('agent', { id: 402, display_name: 'Current Product Agent' }),
    })
    const staleInstall = makeInstall('skill', {
      id: 401,
      listing_id: 401,
      listing: makeListing('skill', { id: 401, display_name: 'Stale Engineering Skill' }),
    })

    mockedListGroupInstallsBatch.mockImplementation(groupNamespaces => {
      if (groupNamespaces.includes('engineering')) {
        return new Promise(resolve => {
          resolveStaleRequest = resolve
        })
      }

      return Promise.resolve({ items: [currentInstall], total: 1, page: 1, limit: 100 })
    })

    const { rerender } = render(
      <InstalledResources resourceType="skill" groupNamespaces={['engineering']} />
    )
    await waitFor(() => expect(mockedListGroupInstallsBatch).toHaveBeenCalledTimes(1))

    rerender(<InstalledResources resourceType="agent" groupNamespaces={['product']} />)

    expect(await screen.findByText('Current Product Agent')).toBeInTheDocument()

    await act(async () => {
      resolveStaleRequest!({ items: [staleInstall], total: 1, page: 1, limit: 100 })
    })

    expect(screen.getByText('Current Product Agent')).toBeInTheDocument()
    expect(screen.queryByText('Stale Engineering Skill')).not.toBeInTheDocument()
    expect(screen.queryByTestId('installed-resources-loading')).not.toBeInTheDocument()
  })

  it.each([
    { bindModes: ['chat', 'code'], expectedHref: '/chat?teamId=128' },
    { bindModes: ['code'], expectedHref: '/chat?agent=code&teamId=128' },
  ])('opens an installed agent in the expected mode', async ({ bindModes, expectedHref }) => {
    mockedListMyInstalls.mockResolvedValue({
      items: [
        makeInstall('agent', {
          listing: makeListing('agent', { bind_modes: bindModes }),
        }),
      ],
      total: 1,
      page: 1,
      limit: 100,
    })

    render(<InstalledResources resourceType="agent" keyword="" />)

    const card = await screen.findByTestId('resource-listing-card-92')
    const primaryActions = within(card).getByTestId('resource-listing-primary-action-92')
    const useButton = within(card).getByTestId('install-resource-92-button')
    expect(
      within(primaryActions).getByTestId('installed-resource-actions-agent-21')
    ).toHaveAccessibleName('更多操作')
    expect(useButton).toHaveClass('h-11', 'w-full', 'md:h-8')
    expect(useButton).toHaveTextContent(bindModes.length === 1 ? '去编码' : '去对话')
    expect(useButton.querySelector('svg')).toBeInTheDocument()
    expect(screen.queryByTestId('resource-listing-footer-92')).not.toBeInTheDocument()
    fireEvent.click(useButton)

    expect(mockPush).toHaveBeenCalledWith(expectedHref)
  })

  it('removes a personal installed agent after confirmation', async () => {
    mockedListMyInstalls.mockResolvedValue({
      items: [makeInstall('agent')],
      total: 1,
      page: 1,
      limit: 100,
    })

    render(<InstalledResources resourceType="agent" />)

    const card = await screen.findByTestId('resource-listing-card-92')
    const primaryActions = within(card).getByTestId('resource-listing-primary-action-92')
    expect(within(card).getByTestId('install-resource-92-button')).toHaveTextContent('去对话')
    const actionsButton = within(primaryActions).getByTestId('installed-resource-actions-agent-21')
    expect(within(primaryActions).queryByText('已添加')).not.toBeInTheDocument()
    expect(actionsButton).toHaveAccessibleName('更多操作')
    fireEvent.click(actionsButton)
    fireEvent.click(await screen.findByTestId('remove-installed-agent-21-button'))
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      '确定取消添加智能体「Installed Agent」吗？'
    )
    fireEvent.click(screen.getByTestId('confirm-remove-installed-agent-button'))

    await waitFor(() => expect(mockedUninstallListing).toHaveBeenCalledWith(92, 'default'))
    expect(screen.queryByTestId('resource-listing-card-92')).not.toBeInTheDocument()
    expect(mockToast).toHaveBeenCalledWith({ title: '已取消添加智能体' })
  })

  it('keeps the installed agent when removal is cancelled', async () => {
    mockedListMyInstalls.mockResolvedValue({
      items: [makeInstall('agent')],
      total: 1,
      page: 1,
      limit: 100,
    })

    render(<InstalledResources resourceType="agent" />)

    await openRemovalConfirmation('agent')
    fireEvent.click(screen.getByTestId('cancel-remove-installed-resource-button'))

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('resource-listing-card-92')).toBeInTheDocument()
    expect(mockedUninstallListing).not.toHaveBeenCalled()
  })

  it('opens the existing resource detail drawer', async () => {
    render(<InstalledResources resourceType="skill" />)

    fireEvent.click(await screen.findByTestId('view-resource-92-button'))

    expect(screen.getByTestId('resource-detail-dialog')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Installed Skill' })).toBeInTheDocument()
  })

  it('shows loading and empty states', async () => {
    let resolveRequest: (
      value: Awaited<ReturnType<typeof resourceLibraryApi.listMyInstalls>>
    ) => void
    mockedListMyInstalls.mockReturnValue(
      new Promise(resolve => {
        resolveRequest = resolve
      })
    )

    render(<InstalledResources resourceType="agent" />)

    expect(screen.getByTestId('installed-resources-loading')).toHaveAttribute(
      'aria-label',
      '正在加载资源'
    )
    expect(screen.getByTestId('installed-resources-loading')).toHaveClass('content-start')

    await act(async () => {
      resolveRequest!({ items: [], total: 0, page: 1, limit: 100 })
    })

    expect(await screen.findByTestId('installed-resources-empty')).toHaveTextContent('暂无资源')
  })

  it('shows an error state and retries the request', async () => {
    mockedListMyInstalls
      .mockRejectedValueOnce(new Error('load failed'))
      .mockResolvedValueOnce({ items: [], total: 0, page: 1, limit: 100 })

    render(<InstalledResources resourceType="skill" />)

    expect(await screen.findByTestId('installed-resources-error')).toHaveTextContent('加载失败')
    fireEvent.click(screen.getByTestId('installed-resources-retry-button'))

    await waitFor(() => expect(mockedListMyInstalls).toHaveBeenCalledTimes(2))
    expect(await screen.findByTestId('installed-resources-empty')).toBeInTheDocument()
  })
})
