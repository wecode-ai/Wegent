import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { LocalWorkItem } from '@/features/todo/todoModel'
import { DeliveryDialog } from './DeliveryDialog'

const item: LocalWorkItem = {
  id: 'todo-1',
  projectId: 7,
  title: 'Implement delivery',
  objective: '',
  description: 'Task context',
  state: 'started',
  assignee: { type: 'ai' },
  collaborators: [],
  blocker: '',
  nextAction: '',
  priority: 'normal',
  attachments: [],
  runtimeRefs: [{ deviceId: 'local', taskId: 'task-1' }],
  events: [],
  sortOrder: 0,
  createdAt: '2026-07-20T00:00:00Z',
  updatedAt: '2026-07-20T00:00:00Z',
}

describe('DeliveryDialog', () => {
  it('creates and finalizes a Markdown-first immutable delivery', async () => {
    const bindTask = vi.fn(async () => undefined)
    const createDelivery = vi.fn(async () => ({ id: 'delivery-1' }))
    const finalizeDelivery = vi.fn(async () => ({ id: 'delivery-1' }))
    const deliveryApi = {
      bindTask,
      createDelivery,
      addAsset: vi.fn(),
      finalizeDelivery,
      discardDraft: vi.fn(),
      listDeliveries: vi.fn(),
    } as unknown as NonNullable<WorkbenchServices['deliveryApi']>

    const view = render(
      <DeliveryDialog
        item={item}
        runtimeTask={{ deviceId: 'local', taskId: 'task-1' }}
        messages={[]}
        deliveryApi={deliveryApi}
        onCancel={vi.fn()}
        onDelivered={vi.fn()}
      />
    )

    const dialog = screen.getByTestId('delivery-dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog.parentElement?.parentElement).toBe(document.body)
    expect(view.container).toBeEmptyDOMElement()

    await userEvent.type(screen.getByTestId('delivery-markdown'), '# Result\nReady to continue')
    await userEvent.click(screen.getByTestId('delivery-confirm'))

    await waitFor(() => expect(finalizeDelivery).toHaveBeenCalledWith('delivery-1'))
    expect(bindTask).toHaveBeenCalledWith('todo-1', {
      deviceId: 'local',
      taskId: 'task-1',
    })
    expect(createDelivery).toHaveBeenCalledWith(
      'todo-1',
      expect.objectContaining({ markdown: '# Result\nReady to continue' })
    )
    expect(screen.getByTestId('delivery-complete-dialog')).toBeInTheDocument()
  })

  it('discards the draft when finalization fails', async () => {
    const discardDraft = vi.fn(async () => undefined)
    const deliveryApi = {
      bindTask: vi.fn(async () => undefined),
      createDelivery: vi.fn(async () => ({ id: 'delivery-failed' })),
      addAsset: vi.fn(),
      finalizeDelivery: vi.fn(async () => {
        throw new Error('Finalize failed')
      }),
      discardDraft,
      listDeliveries: vi.fn(),
    } as unknown as NonNullable<WorkbenchServices['deliveryApi']>
    render(
      <DeliveryDialog
        item={item}
        runtimeTask={{ deviceId: 'local', taskId: 'task-1' }}
        messages={[]}
        deliveryApi={deliveryApi}
        onCancel={vi.fn()}
        onDelivered={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('delivery-confirm'))

    await waitFor(() => expect(discardDraft).toHaveBeenCalledWith('delivery-failed'))
    expect(screen.getByText('Finalize failed')).toBeInTheDocument()
  })
})
