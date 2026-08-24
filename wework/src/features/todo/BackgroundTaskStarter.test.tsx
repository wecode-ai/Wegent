import { render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { RuntimeTaskAddress } from '@/types/api'
import { BackgroundTaskStarter } from './BackgroundTaskStarter'

const mocks = vi.hoisted(() => ({
  createConversation: vi.fn(),
}))

vi.mock('./useProjectRuntimeTaskComposer', () => ({
  useProjectRuntimeTaskComposer: () => mocks.createConversation,
}))

describe('BackgroundTaskStarter', () => {
  it('starts the runtime task without rendering a UI surface', async () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'local-device',
      taskId: 'runtime-created',
    }
    const onAddressChange = vi.fn()
    mocks.createConversation.mockImplementation(async (_input, options) => {
      options.onRuntimeTaskOptimisticOpen(address)
      return address
    })

    const { container } = render(
      <BackgroundTaskStarter
        project={{
          id: 11,
          name: 'Wegent V4',
          description: '',
        }}
        localProjects={[{ id: 91, name: '运营工作区', tasks: [] }]}
        task={{
          id: 'WEG-1',
          cloud_project_id: 11,
          sequence_number: 1,
          parent_id: null,
          created_by_user_id: 1,
          assignee_user_id: null,
          title: 'Implement cloud MCP',
          description: 'Use the shared workspace',
          status: 'pending',
          priority: 'high',
          due_at: null,
          sort_order: 0,
          current_delivery_id: null,
          version: 1,
          created_at: '2026-07-22T00:00:00Z',
          updated_at: '2026-07-22T00:00:00Z',
          completed_at: null,
        }}
        input="Implement cloud MCP"
        initialLocalProjectId={91}
        onAddressChange={onAddressChange}
        onError={vi.fn()}
      />
    )

    expect(container).toBeEmptyDOMElement()
    await waitFor(() => expect(mocks.createConversation).toHaveBeenCalledOnce())
    expect(mocks.createConversation).toHaveBeenCalledWith(
      'Implement cloud MCP',
      expect.objectContaining({
        attachments: [],
        executionModel: {},
        optimisticUserMessage: expect.objectContaining({
          role: 'user',
          content: 'Implement cloud MCP',
        }),
      })
    )
    expect(onAddressChange).toHaveBeenCalledOnce()
    expect(onAddressChange).toHaveBeenCalledWith(address)
  })
})
