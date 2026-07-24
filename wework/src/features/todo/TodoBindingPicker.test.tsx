import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { TodoBindingPicker } from './TodoBindingPicker'

const project = {
  id: 1,
  public_id: 'project-1',
  project_key: 'WEG',
  name: 'Wegent',
  description: '',
  created_by_user_id: 1,
  status: 'active',
  version: 1,
  created_at: '2026-07-22T00:00:00Z',
  updated_at: '2026-07-22T00:00:00Z',
}

const item = {
  id: 'WEG-1',
  cloud_project_id: 1,
  sequence_number: 1,
  created_by_user_id: 1,
  assignee_user_id: null,
  title: 'Cloud TODO',
  description: '',
  status: 'inbox' as const,
  priority: 'none' as const,
  due_at: null,
  sort_order: 0,
  current_delivery_id: null,
  version: 1,
  created_at: '2026-07-22T00:00:00Z',
  updated_at: '2026-07-22T00:00:00Z',
  completed_at: null,
}

function api() {
  return {
    listCloudProjects: vi.fn(async () => ({ items: [project] })),
    listLoopItems: vi.fn(async () => ({ items: [item] })),
    bindTask: vi.fn(async () => undefined),
    bindProjectTask: vi.fn(async () => undefined),
    unbindTask: vi.fn(async () => undefined),
    unbindCloudContext: vi.fn(async () => undefined),
    createLoopItem: vi.fn(async () => item),
  } as unknown as NonNullable<WorkbenchServices['deliveryApi']>
}

describe('TodoBindingPicker', () => {
  it('binds an existing TODO to the local runtime task', async () => {
    const deliveryApi = api()
    const onBound = vi.fn()
    render(
      <TodoBindingPicker
        api={deliveryApi}
        runtimeTask={{ deviceId: 'local-device', taskId: 'task-1' }}
        currentProject={null}
        currentItem={null}
        onClose={vi.fn()}
        onBound={onBound}
      />
    )

    await userEvent.click(await screen.findByTestId('todo-binding-item-WEG-1'))

    await waitFor(() =>
      expect(deliveryApi.bindTask).toHaveBeenCalledWith('WEG-1', {
        deviceId: 'local-device',
        taskId: 'task-1',
      })
    )
    expect(onBound).toHaveBeenCalledWith(project, item)
  })

  it('unbinds the current TODO without deleting it', async () => {
    const deliveryApi = api()
    const onBound = vi.fn()
    render(
      <TodoBindingPicker
        api={deliveryApi}
        runtimeTask={{ deviceId: 'local-device', taskId: 'task-1' }}
        currentProject={project}
        currentItem={item}
        onClose={vi.fn()}
        onBound={onBound}
      />
    )

    await userEvent.click(await screen.findByTestId('todo-binding-unbind'))

    expect(deliveryApi.unbindCloudContext).toHaveBeenCalledWith({
      deviceId: 'local-device',
      taskId: 'task-1',
    })
    expect(onBound).toHaveBeenCalledWith(null, null)
  })

  it('selects and clears a TODO before a local task exists', async () => {
    const deliveryApi = api()
    const onBound = vi.fn()
    const view = render(
      <TodoBindingPicker
        api={deliveryApi}
        currentProject={null}
        currentItem={null}
        onClose={vi.fn()}
        onBound={onBound}
      />
    )

    await userEvent.click(await screen.findByTestId('todo-binding-item-WEG-1'))

    expect(deliveryApi.bindTask).not.toHaveBeenCalled()
    expect(onBound).toHaveBeenCalledWith(project, item)

    view.rerender(
      <TodoBindingPicker
        api={deliveryApi}
        currentProject={project}
        currentItem={item}
        onClose={vi.fn()}
        onBound={onBound}
      />
    )
    await userEvent.click(screen.getByTestId('todo-binding-unbind'))

    expect(deliveryApi.unbindCloudContext).not.toHaveBeenCalled()
    expect(onBound).toHaveBeenLastCalledWith(null, null)
  })

  it('binds only the cloud project when no TODO is selected', async () => {
    const deliveryApi = api()
    const onBound = vi.fn()
    render(
      <TodoBindingPicker
        api={deliveryApi}
        runtimeTask={{ deviceId: 'local-device', taskId: 'task-1' }}
        currentProject={null}
        currentItem={null}
        onClose={vi.fn()}
        onBound={onBound}
      />
    )

    await userEvent.click(await screen.findByTestId('todo-binding-project-only'))

    expect(deliveryApi.bindProjectTask).toHaveBeenCalledWith(
      project.id,
      { deviceId: 'local-device', taskId: 'task-1' },
      undefined
    )
    expect(onBound).toHaveBeenCalledWith(project, null)
  })
})
