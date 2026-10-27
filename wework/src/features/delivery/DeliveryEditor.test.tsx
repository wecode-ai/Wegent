import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '@wegent/collaboration'
import { IssueDeliveryEditor } from '../../../../packages/collaboration/src/issue-detail/IssueDeliveryEditor'
import type { SharedIssueDetailDeliveryDetail } from '../../../../packages/collaboration/src/issue-detail/createSharedIssueDetailPort'

const delivery: SharedIssueDetailDeliveryDetail = {
  id: 'delivery-1',
  loop_item_id: 'issue-1',
  title: 'Original title',
  version: 3,
  status: 'delivered',
  created_at: '2026-10-27T00:00:00Z',
  delivered_at: '2026-10-27T00:00:01Z',
  source_task_snapshot: { deviceId: 'local', taskId: 'runtime-1' },
  markdown: 'Original notes',
  chat: {
    messages: [
      { id: 'm1', role: 'user', content: 'Question' },
      { id: 'm2', role: 'assistant', content: 'Answer' },
    ],
  },
  assets: [
    {
      id: 'asset-1',
      kind: 'file',
      display_name: 'result.txt',
      relative_path: 'reports/result.txt',
      content_type: 'text/plain',
      size_bytes: 3,
      sha256: 'abc',
    },
  ],
  fulfillments: [],
}

function setup(
  update = vi.fn().mockResolvedValue({ ...delivery, title: 'Revised title', version: 4 })
) {
  const api = {
    get: vi.fn().mockResolvedValue(delivery),
    list: vi.fn(),
    update,
    loadSourceMessages: vi.fn().mockResolvedValue([
      { id: 'm1', role: 'user', content: 'Question' },
      { id: 'm2', role: 'assistant', content: 'Answer' },
      { id: 'm3', role: 'assistant', content: 'More evidence' },
    ]),
  }
  const onSaved = vi.fn()
  const onCancel = vi.fn()
  render(
    <IssueDeliveryEditor
      delivery={delivery}
      issueTitle="Issue title"
      api={api}
      translate={createCollaborationTranslator('zh-CN')}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  )
  return { api, onSaved, onCancel, user: userEvent.setup() }
}

describe('delivered artifact editing', () => {
  it('saves title, notes, replacement file and selected source messages together', async () => {
    const { user, api, onSaved } = setup()
    fireEvent.change(screen.getByTestId('delivery-edit-title'), {
      target: { value: 'Revised title' },
    })
    fireEvent.change(screen.getByTestId('delivery-edit-notes'), {
      target: { value: 'Revised notes' },
    })
    await user.click(screen.getByTestId('delivery-edit-message-0'))
    await user.click(screen.getByTestId('delivery-edit-load-messages'))
    await user.click(await screen.findByTestId('delivery-edit-message-2'))
    const file = new File(['replacement'], 'new.txt', { type: 'text/plain' })
    await user.upload(screen.getByTestId('delivery-edit-replace-asset-1'), file)
    await user.click(screen.getByTestId('delivery-edit-save'))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(api.update).toHaveBeenCalledWith('delivery-1', {
      title: 'Revised title',
      version: 3,
      markdown: 'Revised notes',
      retained_asset_ids: [],
      chat: {
        scope: 'selected',
        messages: [
          { id: 'm2', role: 'assistant', content: 'Answer' },
          { id: 'm3', role: 'assistant', content: 'More evidence' },
        ],
      },
      files: [{ relative_path: 'reports/result.txt', file }],
    })
  })

  it('preserves edits after a conflict and allows explicit reload', async () => {
    const { user, api, onSaved } = setup(
      vi.fn().mockRejectedValue(new Error('Delivery changed; reload before saving'))
    )
    fireEvent.change(screen.getByTestId('delivery-edit-notes'), {
      target: { value: 'Original notes unsaved' },
    })
    await user.click(screen.getByTestId('delivery-edit-save'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Delivery changed')
    expect(screen.getByTestId('delivery-edit-notes')).toHaveValue('Original notes unsaved')
    expect(onSaved).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('delivery-edit-reload'))
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(delivery.id))
    expect(onSaved).toHaveBeenCalledWith(delivery)
  })

  it('keeps existing chat when the source is unavailable and cancels without writing', async () => {
    const { user, api, onCancel } = setup()
    api.loadSourceMessages.mockRejectedValueOnce(new Error('offline'))
    await user.click(screen.getByTestId('delivery-edit-load-messages'))
    expect(await screen.findByRole('alert')).toHaveTextContent('来源会话不可用')
    expect(screen.getByTestId('delivery-edit-message-0')).toBeChecked()
    await user.clear(screen.getByTestId('delivery-edit-title'))
    expect(screen.getByTestId('delivery-edit-save')).toBeDisabled()
    await user.click(screen.getByTestId('delivery-edit-cancel'))
    expect(api.update).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalled()
  })
})
