import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { CloudProject } from '@/api/deliveries'
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

describe('CloudProjectManageView', () => {
  test('does not render the deprecated event subscription section', async () => {
    const api = {
      listCloudProjectMembers: vi.fn().mockResolvedValue([]),
      listLoopItems: vi.fn().mockResolvedValue({ items: [] }),
    } as unknown as NonNullable<WorkbenchServices['deliveryApi']>

    render(<CloudProjectManageView api={api} project={project} />)

    expect(await screen.findByRole('heading', { name: '管理项目' })).toBeInTheDocument()
    expect(screen.queryByTestId('event-subscription-settings')).not.toBeInTheDocument()
    expect(screen.queryByTestId('event-subscription-create')).not.toBeInTheDocument()
  })
})
