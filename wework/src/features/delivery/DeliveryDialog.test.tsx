import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { WorkbenchMessage } from '@wegent/chat-core'
import type { Attachment } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { LocalWorkItem } from '@/features/todo/todoModel'
import { DeliveryDialog } from './DeliveryDialog'

const deliveryFileMocks = vi.hoisted(() => ({
  readSelectedDeliveryFiles: vi.fn(),
}))

vi.mock('@/desktop/droppedFiles', () => ({
  readSelectedDeliveryFiles: deliveryFileMocks.readSelectedDeliveryFiles,
}))

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
  beforeEach(() => {
    deliveryFileMocks.readSelectedDeliveryFiles.mockReset()
    deliveryFileMocks.readSelectedDeliveryFiles.mockResolvedValue([])
  })

  it('creates and finalizes a delivery with its title and notes', async () => {
    const onDelivered = vi.fn()
    const bindTask = vi.fn(async () => undefined)
    const createDelivery = vi.fn(async () => ({ id: 'delivery-1' }))
    let completeDelivery!: () => void
    const finalized = new Promise<void>(resolve => {
      completeDelivery = resolve
    })
    const finalizeDelivery = vi.fn(() => finalized)
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
        onDelivered={onDelivered}
      />
    )

    const dialog = screen.getByTestId('delivery-dialog')
    expect(screen.getByTestId('delivery-title')).toHaveValue('Implement delivery')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog.parentElement?.parentElement).toBe(document.body)
    expect(view.container).toBeEmptyDOMElement()

    fireEvent.change(screen.getByTestId('delivery-markdown'), {
      target: { value: '# Result\nReady to continue' },
    })
    await userEvent.click(screen.getByTestId('delivery-confirm'))

    await waitFor(() => expect(finalizeDelivery).toHaveBeenCalledWith('delivery-1'))
    expect(onDelivered).not.toHaveBeenCalled()
    expect(screen.getByTestId('delivery-confirm')).toBeDisabled()
    completeDelivery()
    await waitFor(() => expect(onDelivered).toHaveBeenCalledOnce())
    expect(bindTask).toHaveBeenCalledWith('todo-1', {
      deviceId: 'local',
      taskId: 'task-1',
    })
    expect(createDelivery).toHaveBeenCalledWith(
      'todo-1',
      expect.objectContaining({
        title: 'Implement delivery',
        markdown: '# Result\nReady to continue',
      })
    )
    expect(onDelivered).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('delivery-complete-dialog')).not.toBeInTheDocument()
  })

  it('discards the draft when finalization fails', async () => {
    const onDelivered = vi.fn()
    const discardDraft = vi.fn(async () => undefined)
    const finalizeDelivery = vi
      .fn()
      .mockRejectedValueOnce(new Error('Finalize failed'))
      .mockResolvedValue({ id: 'delivery-failed' })
    const deliveryApi = {
      bindTask: vi.fn(async () => undefined),
      createDelivery: vi.fn(async () => ({ id: 'delivery-failed' })),
      addAsset: vi.fn(),
      finalizeDelivery,
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
        onDelivered={onDelivered}
      />
    )

    await userEvent.click(screen.getByTestId('delivery-confirm'))

    await waitFor(() => expect(discardDraft).toHaveBeenCalledWith('delivery-failed'))
    expect(screen.getByText('Finalize failed')).toBeInTheDocument()
    expect(onDelivered).not.toHaveBeenCalled()
    expect(screen.getByTestId('delivery-confirm')).toBeEnabled()

    await userEvent.click(screen.getByTestId('delivery-confirm'))
    await waitFor(() => expect(onDelivered).toHaveBeenCalledOnce())
    expect(discardDraft).toHaveBeenCalledOnce()
  })

  it('requires explicit message selection instead of delivering the whole conversation by default', async () => {
    const message = {
      id: 'message-1',
      role: 'user',
      content: 'Please implement this',
      status: 'done',
      createdAt: '2026-07-20T00:00:00Z',
    } as WorkbenchMessage
    const deliveryApi = {
      bindTask: vi.fn(async () => undefined),
      createDelivery: vi.fn(async () => ({ id: 'delivery-1' })),
      addAsset: vi.fn(),
      finalizeDelivery: vi.fn(async () => ({ id: 'delivery-1' })),
      discardDraft: vi.fn(),
      listDeliveries: vi.fn(),
    } as unknown as NonNullable<WorkbenchServices['deliveryApi']>

    render(
      <DeliveryDialog
        item={item}
        runtimeTask={{ deviceId: 'local', taskId: 'task-1' }}
        messages={[message]}
        deliveryApi={deliveryApi}
        onCancel={vi.fn()}
        onDelivered={vi.fn()}
      />
    )

    expect(screen.getByTestId('delivery-confirm')).toBeDisabled()
    const messagePicker = screen.getByTestId('delivery-message-picker')
    const messageCheckbox = messagePicker.querySelector('input[type="checkbox"]')
    expect(messageCheckbox).not.toBeNull()
    await userEvent.click(messageCheckbox!)
    expect(screen.getByTestId('delivery-confirm')).toBeEnabled()
  })

  it('uploads only the explicitly selected conversation attachments', async () => {
    const attachment: Attachment = {
      id: -1,
      filename: 'photo.png',
      file_size: 3,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-07-20T00:00:00Z',
      local_path: '/tmp/photo.png',
    }
    const message = {
      id: 'message-1',
      role: 'user',
      content: 'Please look at this',
      status: 'done',
      createdAt: '2026-07-20T00:00:00Z',
      attachments: [attachment],
    } as WorkbenchMessage
    const addAsset = vi.fn(async () => ({ id: 'asset-1' }))
    const deliveryApi = {
      bindTask: vi.fn(async () => undefined),
      createDelivery: vi.fn(async () => ({ id: 'delivery-1' })),
      addAsset,
      finalizeDelivery: vi.fn(async () => ({ id: 'delivery-1' })),
      discardDraft: vi.fn(),
      listDeliveries: vi.fn(),
    } as unknown as NonNullable<WorkbenchServices['deliveryApi']>
    deliveryFileMocks.readSelectedDeliveryFiles.mockResolvedValue([
      { file: new File(['abc'], 'photo.png', { type: 'image/png' }), relativePath: 'photo.png' },
    ])

    render(
      <DeliveryDialog
        item={item}
        runtimeTask={{ deviceId: 'local', taskId: 'task-1' }}
        messages={[message]}
        deliveryApi={deliveryApi}
        onCancel={vi.fn()}
        onDelivered={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('delivery-chat-none'))
    const attachmentPicker = screen.getByTestId('delivery-attachment-picker')
    const attachmentCheckbox = within(attachmentPicker).getByRole('checkbox')
    await userEvent.click(attachmentCheckbox)
    fireEvent.change(screen.getByTestId('delivery-markdown'), { target: { value: 'Done' } })
    await userEvent.click(screen.getByTestId('delivery-confirm'))

    await waitFor(() => expect(deliveryApi.finalizeDelivery).toHaveBeenCalledWith('delivery-1'))
    expect(addAsset).toHaveBeenCalledWith(
      'delivery-1',
      expect.objectContaining({ name: 'photo.png' }),
      'attachments/photo.png'
    )
  })
})
