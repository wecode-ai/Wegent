import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { ThreadWorkMetadata } from './ThreadWorkMetadata'
import { activityFixture } from './threadExecutionActivity.test-support'

vi.mock('./useThreadWorkRecords', () => ({
  useThreadWorkRecords: () => ({
    actor: 7,
    scope: {},
    port: { deliveries: { get: vi.fn() } },
    bindings: { items: [], loading: false, error: false },
    deliveries: { items: [], loading: false, error: false },
    refresh: vi.fn(),
  }),
}))

describe('Private help entry is independent of shared assignment', () => {
  it.each(['agent', 'crew', 'human'] as const)(
    'keeps personal help available for the %s assignee without claiming it',
    assignee => {
      const { context, item } = activityFixture()
      item.assignee_agent_id = assignee === 'agent' ? 'agent' : null
      item.assignee_group_id = assignee === 'crew' ? 'crew' : null
      item.assignee_user_id = assignee === 'human' ? 8 : null
      const create = vi.fn()
      render(
        <ThreadWorkMetadata context={context} locale="zh-CN" onCreate={create} onOpen={vi.fn()} />
      )
      fireEvent.click(screen.getByTestId('cloud-todo-personal-task-start'))
      expect(create).toHaveBeenCalledExactlyOnceWith(context)
      expect(context.item.assignee_user_id).toBe(assignee === 'human' ? 8 : null)
      expect(context.item.assignee_group_id).toBe(assignee === 'crew' ? 'crew' : null)
    }
  )

  it.each(['observer', 'viewer', 'revoked'] as const)(
    'retains the actual permission boundary for %s',
    reason => {
      const { context } = activityFixture()
      if (reason === 'observer') context.participation!.joined = false
      if (reason === 'viewer') context.group.role = 'Viewer'
      if (reason === 'revoked') context.item.permissions!.execute = false
      render(
        <ThreadWorkMetadata context={context} locale="zh-CN" onCreate={vi.fn()} onOpen={vi.fn()} />
      )
      expect(screen.queryByTestId('cloud-todo-personal-task-start')).not.toBeInTheDocument()
    }
  )
})
