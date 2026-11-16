import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectChatMessage } from '@/api/backend/projectChatSocket'
import type { CloudLoopItem } from '@/api/deliveries'
import '@/i18n'
import { IssueManagerEvent } from './IssueManagerEvent'

afterEach(cleanup)

describe('desktop manager execution facts', () => {
  it('describes the assignment without repeating the manager role', () => {
    const message = {
      messageId: 'manager',
      sender: { type: 'agent', id: 'leader', name: '项目负责人' },
      content: '',
      metadata: {
        dispatch_role: 'manager',
        run_status: 'completed',
        dispatch_assignments: [{ task_title: '回复三条使用说明', human_user_name: '我' }],
      },
      status: 'completed',
      createdAt: '2026-11-02T00:00:00Z',
    } as ProjectChatMessage
    const { container } = render(<IssueManagerEvent message={message} task={{} as CloudLoopItem} />)
    expect(container.textContent).toContain('项目负责人 将「回复三条使用说明」分配给我')
    expect(container.textContent).not.toContain('项目负责人 负责人')
  })

  it.each([
    ['waiting_approval', '等待审批'],
    ['queued', '排队中'],
    ['waiting_runtime', '等待设备或模型配置'],
    ['cancelled', '已停止任务规划'],
  ])('retains %s instead of inventing an active planning turn', (status, label) => {
    const message = {
      messageId: 'manager',
      sender: { type: 'agent', id: 'leader', name: '项目负责人' },
      content: '',
      metadata: { dispatch_role: 'manager', run_status: status },
      status: 'pending',
      createdAt: '2026-11-02T00:00:00Z',
    } as ProjectChatMessage
    const { container } = render(<IssueManagerEvent message={message} task={{} as CloudLoopItem} />)
    expect(screen.getByText(label, { exact: false })).toBeInTheDocument()
    expect(screen.queryByText('正在规划任务', { exact: false })).not.toBeInTheDocument()
    expect(container.querySelector('.animate-spin')).toBeNull()
  })
})
