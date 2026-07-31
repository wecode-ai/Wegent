import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { User } from '@/types/api'
import { CloudTodoWorkspace } from './CloudTodoWorkspace'

vi.mock('./ProjectSpaceChatSidebar', () => ({
  ProjectSpaceChatSidebar: ({
    project,
    launchRequest,
    onClose,
  }: {
    project: { id: number; name: string }
    launchRequest?: {
      item: { id: string; description: string }
      localProjectId: number | null
    } | null
    onClose: () => void
  }) => (
    <div
      data-testid="project-space-chat-sidebar"
      data-project-id={project.id}
      data-item-id={launchRequest?.item.id}
      data-description={launchRequest?.item.description}
      data-local-project-id={launchRequest?.localProjectId ?? ''}
    >
      {project.name}
      <button type="button" data-testid="mock-project-space-chat-close" onClick={onClose}>
        关闭
      </button>
    </div>
  ),
}))

const project = {
  id: 11,
  public_id: 'cloud-public-id',
  project_key: 'WEG',
  name: 'Wegent V4',
  description: 'Shared project',
  project_store: 'backend' as const,
  task_provider: 'local' as const,
  provider_config: {},
  created_by_user_id: 1,
  status: 'active',
  version: 1,
  created_at: '2026-07-22T00:00:00Z',
  updated_at: '2026-07-22T00:00:00Z',
}

const item = {
  id: 'WEG-1',
  cloud_project_id: 11,
  sequence_number: 1,
  parent_id: null,
  created_by_user_id: 1,
  assignee_user_id: null,
  title: 'Implement cloud MCP',
  description: 'Use the shared workspace',
  status: 'in_progress' as const,
  priority: 'high' as const,
  due_at: null,
  sort_order: 0,
  current_delivery_id: null,
  version: 1,
  created_at: '2026-07-22T00:00:00Z',
  updated_at: '2026-07-22T00:00:00Z',
  completed_at: null,
}

function services(): WorkbenchServices {
  return {
    deliveryApi: {
      listCloudProjects: vi.fn(async () => ({ items: [project] })),
      createCloudProject: vi.fn(async values => ({
        ...project,
        id: 12,
        project_key: values.project_key ?? 'AUTO123',
        name: values.name,
        description: values.description ?? '',
        task_provider: values.task_provider ?? 'local',
        provider_config: values.provider_config ?? {},
      })),
      updateCloudProject: vi.fn(async (_projectId, values) => ({
        ...project,
        ...values,
        version: project.version + 1,
      })),
      archiveCloudProject: vi.fn(async () => undefined),
      archiveLoopItem: vi.fn(async () => undefined),
      updateLoopItem: vi.fn(async (_itemId, values) => ({
        ...item,
        ...values,
        version: item.version + 1,
      })),
      reorderLoopItems: vi.fn(async () => ({ items: [item] })),
      listLoopItems: vi.fn(async () => ({ items: [item] })),
      listDeliveries: vi.fn(async () => ({ items: [] })),
      listLoopItemAttachments: vi.fn(async () => []),
      addLoopItemAttachment: vi.fn(async (_itemId, file) => ({
        id: 'attachment-1',
        loop_item_id: item.id,
        display_name: file.name,
        content_type: file.type,
        size_bytes: file.size,
        sha256: 'hash',
        created_by_user_id: 1,
        created_at: '2026-07-22T00:00:00Z',
        markdown_url: 'wegent://attachments/attachment-1',
        markdown:
          '[brief.txt](wegent://attachments/attachment-1)\n<!-- wegent-attachment:attachment-1 -->',
      })),
      accessLoopItemAttachment: vi.fn(async () => ({
        url: 'https://storage.test/attachment-1',
        expires_in_seconds: 900,
      })),
      readLoopItemAttachment: vi.fn(async () => new Blob(['context'])),
      downloadLoopItemAttachment: vi.fn(async () => undefined),
      deleteLoopItemAttachment: vi.fn(async () => undefined),
      listTaskBindings: vi.fn(async () => [
        {
          id: 1,
          loop_item_id: item.id,
          task_user_id: 1,
          device_id: 'local-device',
          task_id: 'runtime-248868498',
          task_title: 'Implement cloud delivery',
          backend_task_id: null,
          linked_at: '2026-07-22T00:00:00Z',
        },
      ]),
      listLoopItemCollaborators: vi.fn(async () => [
        {
          id: 1,
          loop_item_id: item.id,
          user_id: 1,
          user_name: 'local',
          email: 'local@example.com',
          source: 'task',
          added_by_user_id: 1,
          created_at: '2026-07-22T00:00:00Z',
        },
      ]),
      addLoopItemCollaborator: vi.fn(async (_itemId, userId) => ({
        id: 2,
        loop_item_id: item.id,
        user_id: userId,
        user_name: 'alice',
        email: 'alice@example.com',
        source: 'manual',
        added_by_user_id: 1,
        created_at: '2026-07-23T00:00:00Z',
      })),
      removeLoopItemCollaborator: vi.fn(async () => undefined),
      bindTask: vi.fn(async () => undefined),
      listMyWork: vi.fn(async () => ({ items: [] })),
      listCloudProjectMembers: vi.fn(async () => [
        {
          id: 1,
          user_id: 1,
          user_name: 'local',
          email: 'local@example.com',
          role: 'Owner',
        },
        {
          id: 2,
          user_id: 2,
          user_name: 'alice',
          email: 'alice@example.com',
          role: 'Developer',
        },
      ]),
      searchCloudProjectUsers: vi.fn(async () => ({ users: [], total: 0 })),
      listCloudFiles: vi.fn(async () => ({ items: [] })),
      listProjectDeliveryFiles: vi.fn(async () => ({ items: [] })),
      createCloudFolder: vi.fn(async (_projectId: number, path: string) => ({
        id: 51,
        cloud_project_id: 11,
        path,
        name: path,
        kind: 'folder',
        content_type: null,
        size_bytes: 0,
        sha256: null,
        description: '',
        created_by_user_id: 1,
        updated_by_user_id: 1,
        version: 1,
        created_at: '2026-07-22T00:00:00Z',
        updated_at: '2026-07-22T00:00:00Z',
      })),
    },
  } as unknown as WorkbenchServices
}

describe('CloudTodoWorkspace', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('renames and archives a project from the sidebar menu', async () => {
    const workbenchServices = services()

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-sidebar-project-more-11'))
    await userEvent.click(screen.getByTestId('cloud-sidebar-rename-project-11'))
    await userEvent.clear(screen.getByTestId('cloud-project-rename-input'))
    await userEvent.type(screen.getByTestId('cloud-project-rename-input'), 'Wegent Next')
    await userEvent.click(screen.getByTestId('cloud-project-rename-confirm'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi!.updateCloudProject).toHaveBeenCalledWith(11, {
        name: 'Wegent Next',
        version: 1,
      })
    )
    expect((await screen.findAllByText('Wegent Next')).length).toBeGreaterThan(0)

    await userEvent.click(screen.getByTestId('cloud-sidebar-project-more-11'))
    await userEvent.click(screen.getByTestId('cloud-sidebar-archive-project-11'))
    await userEvent.click(screen.getByTestId('cloud-project-archive-confirm'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi!.archiveCloudProject).toHaveBeenCalledWith(11, 2)
    )
    expect(screen.queryByTestId('cloud-sidebar-project-11')).not.toBeInTheDocument()
  })

  it('archives a task from its board card', async () => {
    const workbenchServices = services()

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-more-WEG-1'))
    await userEvent.click(screen.getByTestId('cloud-todo-card-archive-WEG-1'))
    await userEvent.click(screen.getByTestId('cloud-todo-archive-confirm'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi!.archiveLoopItem).toHaveBeenCalledWith('WEG-1')
    )
    expect(screen.queryByTestId('cloud-todo-card-WEG-1')).not.toBeInTheDocument()
  })

  it('opens project chat for every project provider', async () => {
    const workbenchServices = services()

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[{ id: 91, name: '运营工作区', tasks: [] }]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    expect(screen.getByTestId('cloud-project-ask-ai')).toHaveTextContent('与 AI 沟通')
    await userEvent.click(screen.getByTestId('cloud-project-ask-ai'))
    expect(screen.getByTestId('project-space-chat-sidebar')).toHaveAttribute(
      'data-project-id',
      '11'
    )
    expect(screen.getByTestId('project-space-chat-sidebar')).toBeInTheDocument()
  })

  it('hides task ids and configures the properties shown on board cards', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [{ ...item, assignee_name: 'hongyu9', tags: ['发布'] }],
    }))
    workbenchServices.deliveryApi!.updateCloudProject = vi.fn(async (_projectId, values) => ({
      ...project,
      card_display: values.card_display,
      version: project.version + 1,
    }))

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])

    expect(await screen.findByText('Implement cloud MCP')).toBeInTheDocument()
    expect(screen.queryByText('WEG-1')).not.toBeInTheDocument()
    expect(screen.getByText('hongyu9')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-card-WEG-1')).toHaveTextContent('负责人')
    expect(screen.getByTestId('cloud-todo-card-assignee-avatar-WEG-1')).toHaveTextContent('H')
    expect(screen.getByTestId('cloud-todo-card-assignee-avatar-WEG-1')).toHaveClass(
      'from-indigo-400',
      'to-indigo-500'
    )
    expect(screen.getByTestId('cloud-todo-card-WEG-1')).toHaveTextContent('高')
    expect(screen.getAllByText('发布').length).toBeGreaterThan(0)

    await userEvent.click(screen.getByTestId('cloud-project-manage-view'))
    expect(screen.getByTestId('cloud-project-board-layout-settings')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-board-display-menu'))
    expect(screen.getByTestId('cloud-project-card-display-settings')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-board-display-assignee'))
    await waitFor(() =>
      expect(workbenchServices.deliveryApi!.updateCloudProject).toHaveBeenCalledWith(
        11,
        expect.objectContaining({
          card_display: expect.objectContaining({ show_assignee: false }),
        })
      )
    )
    await userEvent.click(screen.getByTestId('cloud-project-board-view'))
    expect(screen.queryByText('hongyu9')).not.toBeInTheDocument()
    expect(screen.getAllByText('发布').length).toBeGreaterThan(0)
  })

  it('does not render an avatar for an unassigned board card', async () => {
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services()}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])

    expect(await screen.findByTestId('cloud-todo-card-WEG-1')).toHaveTextContent('未指定')
    expect(screen.queryByTestId('cloud-todo-card-assignee-avatar-WEG-1')).not.toBeInTheDocument()
  })

  it('renders DingTalk records by live table fields without exposing provider record ids', async () => {
    const workbenchServices = services()
    workbenchServices.aitableApi = {
      configureProject: vi.fn(async () => undefined),
      describe: vi.fn(async () => ({
        base: {},
        tables: [],
        active_table: {},
        fields: [
          { id: 'field-status', name: '天河状态', type: 'singleSelect', config: null, raw: {} },
          { id: 'field-owner', name: '负责人', type: 'member', config: {}, raw: {} },
        ],
      })),
    } as WorkbenchServices['aitableApi']
    workbenchServices.deliveryApi!.listCloudProjects = vi.fn(async () => ({
      items: [
        {
          ...project,
          task_provider: 'dingtalk_aitable' as const,
          provider_config: { base_id: 'base-1', table_id: 'table-1' },
        },
      ],
    }))
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [
        {
          ...item,
          id: 'aitable:base-1:record-1',
          title: '修复发布流程',
          assignee_name: '陈波',
          source_cells: { 'field-status': '进行中', 'field-owner': [{ name: '陈波' }] },
          tags: [],
        },
        {
          ...item,
          id: 'aitable:base-1:record-2',
          parent_id: 'aitable:base-1:record-1',
          title: '补齐测试',
          assignee_name: '胡春林',
          source_cells: { 'field-status': '待处理', 'field-owner': [{ name: '胡春林' }] },
          tags: [],
        },
      ],
    }))

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])

    expect(
      await screen.findByTestId('cloud-todo-column-field-field-status-进行中')
    ).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-column-field-field-status-待处理')).toBeInTheDocument()
    expect(screen.queryByText('aitable:base-1:record-1')).not.toBeInTheDocument()
    expect(screen.getByText('修复发布流程')).toBeInTheDocument()
    expect(screen.queryByText('补齐测试')).not.toBeInTheDocument()
    expect(screen.getByTestId('dingtalk-board-group-by')).toHaveTextContent('天河状态')
    expect(screen.getByTestId('dingtalk-board-assignee-filter').parentElement).toHaveTextContent(
      '全部天河状态'
    )

    await userEvent.click(screen.getByTestId('dingtalk-board-group-by'))
    await userEvent.type(screen.getByTestId('dingtalk-board-group-search'), '负责人')
    expect(screen.queryByTestId('dingtalk-board-group-option-field-status')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('dingtalk-board-group-option-field-owner'))
    expect(
      await screen.findByTestId('cloud-todo-column-field-field-owner-陈波')
    ).toBeInTheDocument()
  })

  it('keeps projects visible when one project issue provider fails', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => {
      throw new Error('not_found: task not found')
    })

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    expect((await screen.findAllByText('Wegent V4')).length).toBeGreaterThan(0)
    expect(screen.queryByText('创建第一个项目空间')).not.toBeInTheDocument()
  })

  it('clears the previous project items and shows a skeleton while switching projects', async () => {
    const otherProject = {
      ...project,
      id: 12,
      project_key: 'OTHER',
      name: 'Other Project',
    }
    const otherItem = {
      ...item,
      id: 'OTHER-1',
      cloud_project_id: 12,
      title: 'Other project task',
    }
    let resolveBoardFetch: (() => void) | undefined
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listCloudProjects = vi.fn(async () => ({
      items: [project, otherProject],
    }))
    const selectedProjectIds = new Set<number>()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async (projectId: number) => {
      // The bootstrap preloads counts for every project; only the board fetch
      // for the selected project stays pending so the skeleton can be asserted.
      if (selectedProjectIds.has(projectId)) {
        await new Promise<void>(resolve => {
          resolveBoardFetch = () => resolve()
        })
      }
      selectedProjectIds.add(projectId)
      return { items: projectId === 12 ? [otherItem] : [item] }
    })
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await waitFor(() => expect(screen.getByTestId('cloud-todo-board-loading')).toBeInTheDocument())
    expect(screen.queryByTestId('cloud-todo-card-WEG-1')).not.toBeInTheDocument()
    resolveBoardFetch?.()
    expect(await screen.findByTestId('cloud-todo-card-WEG-1')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-board-loading')).not.toBeInTheDocument()

    await userEvent.click(screen.getAllByText('Other Project')[0])

    // The previous project's cards disappear immediately and the skeleton
    // stays until the new project's items resolve.
    expect(screen.queryByTestId('cloud-todo-card-WEG-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-board-loading')).toBeInTheDocument()

    resolveBoardFetch?.()
    expect(await screen.findByTestId('cloud-todo-card-OTHER-1')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-board-loading')).not.toBeInTheDocument()
  })

  it('shows only one hierarchy level at a time on the board', async () => {
    const workbenchServices = services()
    const child = {
      ...item,
      id: 'WEG-2',
      sequence_number: 2,
      parent_id: item.id,
      title: 'Frontend',
    }
    const grandchild = {
      ...item,
      id: 'WEG-3',
      sequence_number: 3,
      parent_id: child.id,
      title: 'Login page',
    }
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [item, child, grandchild],
    }))
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-project-board-view'))
    expect(await screen.findByTestId('cloud-todo-card-WEG-1')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-card-WEG-2')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-open-children-WEG-1')).toHaveTextContent('子任务 1')

    await userEvent.click(screen.getByTestId('cloud-todo-open-children-WEG-1'))
    expect(await screen.findByTestId('cloud-todo-card-WEG-2')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-card-WEG-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-card-WEG-3')).not.toBeInTheDocument()
    expect(
      screen.getByTestId('cloud-project-header').querySelector('[data-tauri-drag-region]')
    ).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('cloud-todo-open-children-WEG-2'))
    expect(await screen.findByTestId('cloud-todo-card-WEG-3')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '顶层任务' }))
    expect(await screen.findByTestId('cloud-todo-card-WEG-1')).toBeInTheDocument()
  })

  it('creates a child directly from a board card', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.createLoopItem = vi.fn(async (_projectId, values) => ({
      ...item,
      id: 'WEG-2',
      sequence_number: 2,
      title: values.title,
      parent_id: values.parent_id ?? null,
    }))
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-project-board-view'))
    expect(await screen.findByTestId('cloud-todo-card-add-child-WEG-1')).toHaveTextContent(
      '新建子任务'
    )
    await userEvent.click(await screen.findByTestId('cloud-todo-card-add-child-WEG-1'))
    expect(screen.getByTestId('cloud-todo-create-parent')).toHaveValue('WEG-1')
    await userEvent.type(screen.getByTestId('cloud-todo-title'), 'Frontend')
    await userEvent.click(screen.getByRole('button', { name: '创建任务' }))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.createLoopItem).toHaveBeenCalledWith(11, {
        title: 'Frontend',
        description: '',
        priority: 'none',
        status: 'inbox',
        parent_id: 'WEG-1',
        tags: [],
      })
    )
  })

  it('associates an existing task with a parent from the edit dialog', async () => {
    const workbenchServices = services()
    const parent = {
      ...item,
      id: 'WEG-2',
      sequence_number: 2,
      title: 'Release',
      parent_id: null,
    }
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({ items: [item, parent] }))
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))
    await userEvent.selectOptions(screen.getByTestId('cloud-todo-detail-parent'), 'WEG-2')
    await userEvent.click(screen.getByTestId('cloud-todo-save'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.updateLoopItem).toHaveBeenCalledWith('WEG-1', {
        version: 1,
        title: item.title,
        description: item.description,
        priority: item.priority,
        status: item.status,
        parent_id: 'WEG-2',
        assignee_user_id: null,
        due_at: null,
        tags: [],
      })
    )
  })

  it('uses cloud projects as the primary navigation and opens a TODO detail', async () => {
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services()}
      />
    )

    expect(screen.getByTestId('cloud-todo-workspace')).toHaveClass('absolute', 'inset-0', 'w-full')
    expect(screen.getByTestId('cloud-todo-workspace').querySelector('aside')).toHaveClass(
      'w-[240px]',
      'bg-[rgb(var(--color-sidebar))]'
    )
    expect(screen.queryByTestId('cloud-todo-app-current')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-sidebar-chrome-controls')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-sidebar-chrome-controls')).toContainElement(
      screen.getByTestId('cloud-todo-collapse-sidebar')
    )
    expect(screen.getByTestId('cloud-todo-sidebar-chrome-controls')).toContainElement(
      screen.getByTestId('cloud-search-toggle')
    )
    expect(screen.getAllByTestId('macos-titlebar-drag-region')).toHaveLength(1)
    expect((await screen.findAllByText('项目空间')).length).toBeGreaterThan(0)
    expect(screen.getByText('我的工作')).toHaveClass('h-[30px]', 'px-2', 'text-base')
    await waitFor(() => expect(screen.getAllByText('Wegent V4').length).toBeGreaterThan(0))
    await userEvent.click(screen.getAllByText('Wegent V4')[0])
    const projectHeader = screen.getByTestId('cloud-project-header')
    expect(projectHeader).toHaveClass('h-[52px]', 'shrink-0')
    expect(projectHeader.querySelector('[data-tauri-drag-region]')).toBeInTheDocument()
    expect(screen.getAllByTestId('macos-titlebar-drag-region')).toHaveLength(1)
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))

    expect(await screen.findByText('任务详情')).toBeInTheDocument()
    expect(screen.getAllByText('Implement cloud MCP').length).toBeGreaterThan(0)
    expect(screen.getByText('Implement cloud delivery')).toBeInTheDocument()
    expect(screen.getAllByText('local').length).toBeGreaterThan(0)
    expect(screen.getByText('自动加入')).toBeInTheDocument()
  })

  it('copies the cloud project ID before or after opening the project', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services()}
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-project-copy-id-11'))
    expect(writeText).toHaveBeenLastCalledWith('11')

    await userEvent.click(screen.getByTestId('cloud-sidebar-project-11'))
    await userEvent.click(screen.getByTestId('cloud-sidebar-project-more-11'))
    expect(screen.getByTestId('cloud-sidebar-project-menu-11')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-project-header'))
    expect(screen.queryByTestId('cloud-sidebar-project-menu-11')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('cloud-sidebar-project-more-11'))
    await userEvent.click(screen.getByTestId('cloud-sidebar-copy-project-id-11'))

    expect(writeText).toHaveBeenLastCalledWith('11')
    expect(screen.queryByTestId('cloud-sidebar-project-menu-11')).not.toBeInTheDocument()
  })

  it('manually adds a project member as a TODO collaborator', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))
    expect((await screen.findAllByText(/参与者/)).length).toBeGreaterThan(0)
    await userEvent.click(screen.getByTestId('cloud-todo-add-collaborator'))
    await userEvent.selectOptions(screen.getByTestId('cloud-todo-collaborator-select'), '2')
    await userEvent.click(screen.getByTestId('cloud-todo-confirm-collaborator'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.addLoopItemCollaborator).toHaveBeenCalledWith(
        'WEG-1',
        2
      )
    )
    expect((await screen.findAllByText('alice')).length).toBeGreaterThan(0)
  })

  it('creates a child from the task detail', async () => {
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services()}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))
    await userEvent.click(await screen.findByTestId('cloud-todo-detail-add-child'))

    expect(screen.getByTestId('cloud-todo-create-parent')).toHaveValue('WEG-1')
    expect(screen.getAllByText('新建子任务').length).toBeGreaterThan(0)
  })

  it('adds an attachment from the TODO edit dialog', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))
    const file = new File(['context'], 'brief.txt', { type: 'text/plain' })
    await userEvent.upload(screen.getByTestId('cloud-todo-attachment-input'), file)

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.addLoopItemAttachment).toHaveBeenCalledWith(
        'WEG-1',
        file
      )
    )
    expect((await screen.findAllByText('brief.txt')).length).toBeGreaterThan(0)

    await userEvent.click(screen.getByTestId('cloud-todo-attachment-download-attachment-1'))
    expect(workbenchServices.deliveryApi?.downloadLoopItemAttachment).toHaveBeenCalledWith(
      'attachment-1',
      'brief.txt'
    )
  })

  it('collapses and restores the sidebar chrome', async () => {
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services()}
      />
    )

    expect(screen.getByTestId('cloud-todo-sidebar-chrome-controls')).toHaveClass('gap-1')
    await userEvent.click(screen.getByTestId('cloud-todo-collapse-sidebar'))
    expect(screen.queryByTestId('cloud-todo-collapsed-app-current')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-collapsed-chrome-controls')).toHaveClass('left-2')

    await userEvent.click(screen.getByTestId('cloud-todo-expand-sidebar'))
    expect(screen.queryByTestId('cloud-todo-collapsed-chrome-controls')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-sidebar-chrome-controls')).toBeInTheDocument()
  })

  it('opens the cloud project creation flow', async () => {
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services()}
      />
    )
    await waitFor(() => expect(screen.getByTestId('cloud-project-add')).toBeInTheDocument())
    await userEvent.click(screen.getByTestId('cloud-project-add'))
    expect(screen.getByTestId('cloud-project-name')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-project-location-cloud')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByTestId('cloud-project-task-provider-local')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-project-task-provider-github')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-project-task-provider-gitlab')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-project-key')).not.toBeInTheDocument()
  })

  it('creates a project space without requesting a project key', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-project-add'))
    await userEvent.type(screen.getByTestId('cloud-project-name'), 'Wegent Test')
    await userEvent.click(screen.getByTestId('cloud-project-create-confirm'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.createCloudProject).toHaveBeenCalledWith({
        name: 'Wegent Test',
        description: '',
        task_provider: 'local',
        provider_config: {},
        visibility: 'private',
      })
    )
    expect(screen.queryByTestId('cloud-project-name')).not.toBeInTheDocument()
  })

  it('requires only a project-space name before creating', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-project-add'))
    expect(screen.getByTestId('cloud-project-create-confirm')).toBeDisabled()
    await userEvent.type(screen.getByTestId('cloud-project-name'), '中文项目空间')
    expect(screen.getByTestId('cloud-project-create-confirm')).toBeEnabled()
    expect(workbenchServices.deliveryApi?.createCloudProject).not.toHaveBeenCalled()
  })

  it('configures an encrypted GitHub provider for a local project', async () => {
    const workbenchServices = services()
    workbenchServices.projectSpaceApis = {
      local: workbenchServices.deliveryApi,
      defaultLocation: 'local',
    }
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-project-add'))
    await userEvent.type(screen.getByTestId('cloud-project-name'), 'GitHub board')
    await userEvent.click(screen.getByTestId('cloud-project-task-provider-github'))
    await userEvent.type(screen.getByTestId('cloud-project-provider-repository'), 'acme/repo')
    await userEvent.type(screen.getByTestId('cloud-project-provider-token'), 'github-secret')
    await userEvent.click(screen.getByTestId('cloud-project-create-confirm'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.createCloudProject).toHaveBeenCalledWith({
        name: 'GitHub board',
        description: '',
        task_provider: 'github',
        provider_config: {
          repository: 'acme/repo',
          token: 'github-secret',
        },
      })
    )
  })

  it('allows a cloud project to use GitLab Issues', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-project-add'))
    expect(screen.getByTestId('cloud-project-location-cloud')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await userEvent.type(screen.getByTestId('cloud-project-name'), 'Cloud GitLab board')
    await userEvent.click(screen.getByTestId('cloud-project-task-provider-gitlab'))
    await userEvent.type(screen.getByTestId('cloud-project-provider-repository'), 'group/project')
    await userEvent.click(screen.getByTestId('cloud-project-create-confirm'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.createCloudProject).toHaveBeenCalledWith({
        name: 'Cloud GitLab board',
        description: '',
        task_provider: 'gitlab',
        provider_config: {
          repository: 'group/project',
        },
        visibility: 'private',
      })
    )
  })

  it('creates a cloud DingTalk AI Table project from a shared link', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-project-add'))
    await userEvent.type(screen.getByTestId('cloud-project-name'), '钉钉需求池')
    await userEvent.click(screen.getByTestId('cloud-project-task-provider-dingtalk_aitable'))
    expect(screen.getByTestId('cloud-project-create-confirm')).toBeDisabled()
    await userEvent.type(
      screen.getByTestId('cloud-project-aitable-url'),
      'https://alidocs.dingtalk.com/i/nodes/pYLaezmVN63PAZGPTPKyr2X3VrMqPxX6?iframeQuery=entrance%3Ddata%26sheetId%3DhERWDMS%26viewId%3DqvGDAH2'
    )
    expect(screen.queryByTestId('cloud-project-aitable-token')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-project-create-confirm'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.createCloudProject).toHaveBeenCalledWith({
        name: '钉钉需求池',
        description: '',
        task_provider: 'dingtalk_aitable',
        provider_config: {
          base_id: 'pYLaezmVN63PAZGPTPKyr2X3VrMqPxX6',
          table_id: 'hERWDMS',
          source_url:
            'https://alidocs.dingtalk.com/i/nodes/pYLaezmVN63PAZGPTPKyr2X3VrMqPxX6?iframeQuery=entrance%3Ddata%26sheetId%3DhERWDMS%26viewId%3DqvGDAH2',
          view_id: 'qvGDAH2',
        },
        visibility: 'private',
      })
    )
  })

  it('routes an explicitly local project to the local project-space API', async () => {
    const cloudServices = services()
    const localServices = services()
    localServices.deliveryApi!.listCloudProjects = vi.fn(async () => ({ items: [] }))
    cloudServices.projectSpaceApis = {
      local: localServices.deliveryApi,
      cloud: cloudServices.deliveryApi,
      defaultLocation: 'cloud',
    }
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={cloudServices}
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-project-add'))
    await userEvent.click(screen.getByTestId('cloud-project-location-local'))
    await userEvent.type(screen.getByTestId('cloud-project-name'), 'Local board')
    await userEvent.click(screen.getByTestId('cloud-project-create-confirm'))

    await waitFor(() =>
      expect(localServices.deliveryApi?.createCloudProject).toHaveBeenCalledWith({
        name: 'Local board',
        description: '',
        task_provider: 'local',
        provider_config: {},
      })
    )
    expect(cloudServices.deliveryApi?.createCloudProject).not.toHaveBeenCalled()
  })

  it('opens project member management and searches tasks without hiding the board', async () => {
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services()}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-project-manage-view'))
    expect(screen.getByText('管理项目')).toBeInTheDocument()
    expect(await screen.findByText('2 位成员')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-project-members-toggle'))
    expect(await screen.findByTestId('cloud-project-member-1')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-project-board-view'))

    await userEvent.click(screen.getByTestId('cloud-project-task-search-toggle'))
    await userEvent.type(screen.getByTestId('cloud-project-task-search-input'), 'missing')
    expect(screen.getByText('没有匹配的任务')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-card-WEG-1')).toBeInTheDocument()
  })

  it('opens the global search with Command+K and opens a task result', async () => {
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services()}
      />
    )

    await screen.findAllByText('Wegent V4')
    await userEvent.keyboard('{Meta>}k{/Meta}')
    await userEvent.type(screen.getByTestId('cloud-global-search-input'), 'WEG-1')
    await userEvent.click(await screen.findByTestId('cloud-global-search-result-WEG-1'))

    expect(await screen.findByTestId('cloud-todo-detail')).toBeInTheDocument()
  })

  it('restores a missing cloud GitLab credential from project management', async () => {
    const workbenchServices = services()
    const externalProject = {
      ...project,
      task_provider: 'gitlab' as const,
      provider_config: {
        repository: 'group/project',
        domain: 'gitlab.example.com',
        api_base: 'https://gitlab.example.com/api/v4',
        credential_configured: false,
      },
    }
    workbenchServices.deliveryApi!.listCloudProjects = vi.fn(async () => ({
      items: [externalProject],
    }))
    workbenchServices.deliveryApi!.updateCloudProject = vi.fn(async (_projectId, values) => ({
      ...externalProject,
      provider_config: {
        repository: 'group/project',
        domain: 'gitlab.example.com',
        api_base: 'https://gitlab.example.com/api/v4',
        credential_configured: true,
      },
      version: values.version + 1,
    }))

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-project-manage-view'))
    expect(screen.getByText('需要配置令牌')).toBeInTheDocument()
    const tagHeading = screen.getByRole('heading', { name: '标签' })
    const providerHeading = screen.getByRole('heading', { name: '任务来源' })
    expect(
      tagHeading.compareDocumentPosition(providerHeading) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(screen.getByTestId('cloud-project-provider-manage-save')).toHaveClass(
      'bg-black',
      'text-white',
      'disabled:bg-black',
      'disabled:text-white'
    )
    await userEvent.click(screen.getByRole('button', { name: '＋ 新建标签' }))
    expect(screen.getByTestId('cloud-project-tag-create-confirm')).toHaveClass(
      'bg-black',
      'text-white',
      'disabled:bg-black',
      'disabled:text-white'
    )
    expect(screen.getByTestId('cloud-project-tag-create-confirm')).not.toHaveClass(
      'disabled:opacity-50'
    )
    await userEvent.type(screen.getByTestId('cloud-project-provider-manage-token'), 'gitlab-secret')
    await userEvent.click(screen.getByTestId('cloud-project-provider-manage-save'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi!.updateCloudProject).toHaveBeenCalledWith(11, {
        version: 1,
        provider_config: {
          repository: 'group/project',
          domain: 'gitlab.example.com',
          api_base: 'https://gitlab.example.com/api/v4',
          token: 'gitlab-secret',
        },
      })
    )
    expect(await screen.findByText('已保存')).toBeInTheDocument()
  })

  it('updates the DingTalk connection without exposing board mappings', async () => {
    const workbenchServices = services()
    const aitableProject = {
      ...project,
      task_provider: 'dingtalk_aitable' as const,
      provider_config: {
        base_id: 'base-1',
        table_id: 'table-1',
        source_url: 'https://alidocs.dingtalk.com/i/nodes/base-1?iframeQuery=sheetId%3Dtable-1',
        credential_configured: true,
        board_mapping: { title_field_id: 'fld-title' },
      },
    }
    workbenchServices.deliveryApi!.listCloudProjects = vi.fn(async () => ({
      items: [aitableProject],
    }))
    workbenchServices.deliveryApi!.updateCloudProject = vi.fn(async (_projectId, values) => ({
      ...aitableProject,
      provider_config: values.provider_config ?? aitableProject.provider_config,
      version: values.version + 1,
    }))
    workbenchServices.aitableApi = {
      configureProject: vi.fn(async () => undefined),
      describe: vi.fn(async () => ({
        base: {},
        tables: [],
        active_table: {},
        fields: [
          { id: 'fld-title', name: '需求名称', type: 'text', config: {}, raw: {} },
          { id: 'fld-status', name: '状态', type: 'singleSelect', config: {}, raw: {} },
        ],
      })),
      listRecords: vi.fn(async () => ({ items: [], cursor: null, has_more: false })),
      createRecord: vi.fn(),
      updateRecord: vi.fn(),
      deleteRecord: vi.fn(),
      createField: vi.fn(),
      updateField: vi.fn(),
      deleteField: vi.fn(),
    }
    workbenchServices.dwsApi = {
      authStatus: vi.fn(async () => ({
        authenticated: true,
        token_valid: true,
        corp_name: '测试组织',
      })),
      login: vi.fn(() => new Promise<void>(() => undefined)),
      logout: vi.fn(async () => undefined),
    }

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-project-manage-view'))
    expect(screen.queryByText('看板字段映射')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('aitable-manage-save'))

    expect(screen.queryByTestId('aitable-status-mode-custom')).not.toBeInTheDocument()

    await waitFor(() =>
      expect(workbenchServices.deliveryApi!.updateCloudProject).toHaveBeenCalledWith(11, {
        version: 1,
        provider_config: {
          base_id: 'base-1',
          table_id: 'table-1',
          source_url: 'https://alidocs.dingtalk.com/i/nodes/base-1?iframeQuery=sheetId%3Dtable-1',
        },
      })
    )
    await userEvent.click(screen.getByTestId('aitable-dws-login'))
    expect(workbenchServices.dwsApi.login).toHaveBeenCalledOnce()
    expect(screen.getByTestId('aitable-dws-login')).toHaveTextContent('等待浏览器授权…')
    expect(screen.getByTestId('aitable-dws-login')).toBeDisabled()
  })

  it('keeps the project header above the macOS drag region and opens new TODO', async () => {
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services()}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    expect(screen.getByTestId('cloud-project-header')).toHaveClass('relative', 'z-10')
    await userEvent.click(screen.getByTestId('cloud-todo-add'))

    expect(screen.getByTestId('cloud-todo-title')).toBeInTheDocument()
    expect(screen.getAllByText('新建任务').length).toBeGreaterThan(1)
  })

  it('selects a parent while creating and exposes only one create action', async () => {
    const workbenchServices = services()
    const parent = { ...item, id: 'WEG-2', sequence_number: 2, title: 'Release' }
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({ items: [item, parent] }))
    workbenchServices.deliveryApi!.createLoopItem = vi.fn(async (_projectId, values) => ({
      ...item,
      id: 'WEG-3',
      title: values.title,
      parent_id: values.parent_id ?? null,
    }))
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(screen.getByTestId('cloud-todo-add'))
    await userEvent.selectOptions(screen.getByTestId('cloud-todo-create-parent'), 'WEG-2')
    await userEvent.type(screen.getByTestId('cloud-todo-title'), 'Child task')
    expect(screen.queryByText('创建并完成')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-todo-create-confirm'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi.createLoopItem).toHaveBeenCalledWith(11, {
        title: 'Child task',
        description: '',
        priority: 'none',
        status: 'inbox',
        parent_id: 'WEG-2',
        tags: [],
      })
    )
  })

  it('edits TODO metadata without changing historical deliveries', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))
    expect(screen.queryByTestId('cloud-todo-save')).not.toBeInTheDocument()
    await userEvent.clear(screen.getByTestId('cloud-todo-detail-title'))
    await userEvent.type(screen.getByTestId('cloud-todo-detail-title'), 'Updated TODO')
    await userEvent.click(screen.getByTestId('cloud-todo-save'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.updateLoopItem).toHaveBeenCalledWith('WEG-1', {
        version: 1,
        title: 'Updated TODO',
        description: 'Use the shared workspace',
        parent_id: null,
        priority: 'high',
        status: 'in_progress',
        assignee_user_id: null,
        due_at: null,
        tags: [],
      })
    )
    expect((await screen.findAllByText('Updated TODO')).length).toBeGreaterThan(0)
  })

  it('offers a conversation for a completed TODO', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [{ ...item, status: 'completed' as const }],
    }))
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))

    expect(screen.getByTestId('cloud-todo-start-task')).toHaveTextContent('开始对话')
    expect(screen.getByTestId('cloud-todo-detail-title')).toBeEnabled()
  })

  it('opens a task conversation in the project sidebar with an optional Wework project', async () => {
    const workbenchServices = services()

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[{ id: 91, name: 'Wegent 本地项目', tasks: [] }]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))
    await userEvent.click(screen.getByTestId('cloud-todo-start-task'))

    const sidebar = screen.getByTestId('project-space-chat-sidebar')
    expect(sidebar).toHaveAttribute('data-project-id', '11')
    expect(sidebar).toHaveAttribute('data-item-id', item.id)
    expect(sidebar).toHaveAttribute('data-description', item.description)
    expect(sidebar).toHaveAttribute('data-local-project-id', '')

    await userEvent.click(screen.getByTestId('mock-project-space-chat-close'))
    await userEvent.click(screen.getByTestId('cloud-project-ask-ai'))

    const reopenedSidebar = screen.getByTestId('project-space-chat-sidebar')
    expect(reopenedSidebar).not.toHaveAttribute('data-item-id')
    expect(reopenedSidebar).not.toHaveAttribute('data-description')
    expect(reopenedSidebar).toHaveAttribute('data-local-project-id', '')
  })

  it('offers every board status when editing a completed TODO', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [{ ...item, status: 'completed' as const }],
    }))
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))
    const status = screen.getByTestId('cloud-todo-detail-status')
    expect(status).toHaveValue('completed')
    expect(status.querySelectorAll('option')).toHaveLength(5)
    expect(status).toHaveTextContent('已完成')
    expect(status).toHaveTextContent('进行中')
    expect(status).toHaveTextContent('收集箱')
  })

  it('uses the DingTalk-style grouping, filtering, and search toolbar', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.updateCloudProject = vi.fn(async (_projectId, values) => ({
      ...project,
      board_config: values.board_config,
      version: project.version + 1,
    }))
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    expect(await screen.findByTestId('cloud-todo-card-WEG-1')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-column-in_progress')).toHaveTextContent(
      'Implement cloud MCP'
    )
    await userEvent.selectOptions(screen.getByTestId('cloud-board-group-filter'), 'in_progress')
    expect(screen.getByTestId('cloud-board-group-filter-label')).toHaveTextContent('进行中')
    await userEvent.click(screen.getByTestId('cloud-board-group-by'))
    await userEvent.click(screen.getByTestId('cloud-board-group-option-priority'))
    expect(localStorage.getItem('wework-board-group:1:11')).toBe('priority')
    expect(screen.getByTestId('cloud-todo-column-priority-high')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-board-group-filter')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-board-search')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-board-save-global'))
    await waitFor(() =>
      expect(workbenchServices.deliveryApi!.updateCloudProject).toHaveBeenCalledWith(
        11,
        expect.objectContaining({
          board_config: expect.objectContaining({ group_by: 'priority' }),
        })
      )
    )
    expect(screen.queryByTestId('cloud-board-save-global')).not.toBeInTheDocument()
  })

  it('groups native board tasks by tag and keeps the tag filter beside grouping', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [{ ...item, tags: ['发布'] }],
    }))
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(screen.getByTestId('cloud-board-group-by'))
    await userEvent.click(screen.getByTestId('cloud-board-group-option-tag'))

    expect(screen.getByTestId('cloud-todo-column-tag-发布')).toHaveTextContent(
      'Implement cloud MCP'
    )
    expect(screen.getByTestId('cloud-todo-column-tag-untagged')).not.toHaveTextContent(
      'Implement cloud MCP'
    )
    expect(screen.getByTestId('cloud-board-group-filter-label')).toHaveTextContent('全部标签')
  })

  it('defaults new TODOs to the inbox unless another status is selected', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.createLoopItem = vi.fn(async (_projectId, values) => ({
      ...item,
      title: values.title,
      description: values.description ?? '',
      status: values.status ?? 'inbox',
    }))
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(screen.getByTestId('cloud-todo-add'))
    expect(screen.getByTestId('cloud-todo-create-status')).toHaveValue('inbox')
    await userEvent.type(screen.getByTestId('cloud-todo-title'), 'Inbox TODO')
    await userEvent.click(screen.getByRole('button', { name: '创建任务' }))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.createLoopItem).toHaveBeenCalledWith(11, {
        title: 'Inbox TODO',
        description: '',
        priority: 'none',
        status: 'inbox',
        tags: [],
      })
    )
  })

  it('prefills a new TODO with its board column status and allows changing it', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.createLoopItem = vi.fn(async (_projectId, values) => ({
      ...item,
      title: values.title,
      description: values.description ?? '',
      status: values.status ?? 'inbox',
    }))
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(screen.getByTestId('cloud-todo-column-add-in_progress'))
    const status = screen.getByTestId('cloud-todo-create-status')
    expect(status).toHaveValue('in_progress')

    await userEvent.selectOptions(status, 'pending')
    await userEvent.type(screen.getByTestId('cloud-todo-title'), 'Pending TODO')
    await userEvent.click(screen.getByRole('button', { name: '创建任务' }))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.createLoopItem).toHaveBeenCalledWith(11, {
        title: 'Pending TODO',
        description: '',
        priority: 'none',
        status: 'pending',
        tags: [],
      })
    )
  })

  it('adds a create-work-item action to every board column', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    for (const state of ['inbox', 'pending', 'in_progress', 'in_review', 'completed']) {
      expect(screen.getByTestId(`cloud-todo-column-dropzone-${state}`)).toHaveClass(
        'overflow-y-auto',
        'overscroll-y-contain',
        'px-2',
        'pt-2'
      )
      expect(screen.getByTestId(`cloud-todo-column-dropzone-${state}`)).not.toHaveClass('p-2')
      const bottomAdd = screen.getByTestId(`cloud-todo-column-bottom-add-${state}`)
      expect(bottomAdd).toBeVisible()
      // The footer add button stays pinned below the scrollable card list
      // instead of scrolling away or overlapping cards.
      expect(screen.getByTestId(`cloud-todo-column-dropzone-${state}`)).not.toContainElement(
        bottomAdd
      )
      expect(bottomAdd).not.toHaveClass('sticky', 'bottom-0')
    }

    await userEvent.click(screen.getByTestId('cloud-todo-column-bottom-add-completed'))
    expect(screen.getByTestId('cloud-todo-create-status')).toHaveValue('completed')
  })

  it('opens the detail drawer from my work without switching to the board', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listMyWork = vi.fn(async () => ({
      items: [{ ...item, project_key: 'WEG', project_name: 'Wegent V4', has_active_task: false }],
    }))
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-my-work'))
    await userEvent.click(await screen.findByTestId('my-work-group-action-WEG-1'))

    // The drawer opens in place and the my-work view stays mounted.
    expect(await screen.findByTestId('cloud-todo-detail')).toBeVisible()
    expect(screen.getByTestId('cloud-todo-detail-title')).toHaveValue('Implement cloud MCP')
    expect(screen.getByTestId('my-work-group-action-WEG-1')).toBeVisible()
    expect(screen.queryByTestId('cloud-todo-board-breadcrumb')).toBeNull()
  })

  it('uses pointer dragging for TODO cards without starting a native system drag', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )
    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    const card = await screen.findByTestId('cloud-todo-card-WEG-1')
    expect(card).not.toHaveAttribute('draggable')
  })

  it('creates a shared cloud folder from the files view', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(screen.getByRole('button', { name: '文件' }))
    expect(
      screen.getByTestId('cloud-project-header').querySelector('[data-tauri-drag-region]')
    ).toBeInTheDocument()
    await userEvent.click(await screen.findByTestId('cloud-folder-add'))
    await userEvent.type(screen.getByTestId('cloud-folder-name'), 'docs')
    await userEvent.click(screen.getByTestId('cloud-folder-create-confirm'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.createCloudFolder).toHaveBeenCalledWith(11, 'docs')
    )
  })
})
