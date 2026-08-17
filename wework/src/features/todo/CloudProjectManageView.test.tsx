import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { CloudProject } from '@/api/deliveries'
import type { createProjectIncomingHookApi } from '@/api/projectIncomingHooks'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { CloudProjectManageView } from './CloudProjectManageView'

const project: CloudProject = {
  id: 'project-1',
  public_id: 'public-1',
  project_key: 'HOOK',
  name: 'Incoming hook project',
  description: '',
  project_store: 'backend',
  task_provider: 'local',
  provider_config: {},
  card_display: {
    show_assignee: true,
    show_priority: true,
    show_tags: true,
    show_date: true,
  },
  board_config: {
    group_by: 'status',
    statuses: [
      { id: 'inbox', name: '收集箱', color: 'gray' },
      { id: 'pending', name: '待开始', color: 'blue' },
    ],
  },
  ai_automation: {
    auto_retry_on_failure: false,
    max_retry_count: 1,
  },
  created_by_user_id: 1,
  current_user_id: 1,
  current_user_name: 'owner',
  access_role: 'Owner',
  visibility: 'private',
  status: 'active',
  tags: [],
  version: 1,
  created_at: '2026-08-16T00:00:00Z',
  updated_at: '2026-08-16T00:00:00Z',
}

describe('CloudProjectManageView incoming hooks', () => {
  test('creates and exposes a copyable incoming URL', async () => {
    const hook = {
      id: 'hook-1',
      projectId: project.id,
      name: '外部系统',
      status: 'active' as const,
      webhookUrl: 'https://cloud.example/api/v1/incoming-hooks/secret',
      version: 1,
      createdAt: '2026-08-16T00:00:00Z',
      updatedAt: '2026-08-16T00:00:00Z',
    }
    const incomingHookApi = {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(hook),
      update: vi.fn(),
      rotate: vi.fn(),
    } as unknown as ReturnType<typeof createProjectIncomingHookApi>
    const api = {
      listCloudProjectMembers: vi.fn().mockResolvedValue([]),
      listLoopItems: vi.fn().mockResolvedValue({ items: [] }),
    } as unknown as NonNullable<WorkbenchServices['deliveryApi']>
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    render(<CloudProjectManageView api={api} incomingHookApi={incomingHookApi} project={project} />)

    expect(await screen.findByTestId('incoming-hook-settings')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('incoming-hook-empty-create'))

    await waitFor(() => expect(incomingHookApi.create).toHaveBeenCalledWith(project.id, '外部系统'))
    expect(await screen.findByText(hook.webhookUrl)).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('incoming-hook-copy-hook-1'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(hook.webhookUrl))
  })
})
