// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import {
  cloudDeviceEndpoint,
  assistantEndpointFromRoster,
  createAssistantConversation,
  createAssistantInteraction,
  createRuntimeAssistantTransport,
  localWeworkEndpoint,
  wegentAgentEndpoint,
  type AssistantConversation,
  type AssistantEndpoint,
  type AssistantEndpointKind,
  type AssistantInteractionRequest,
  type AssistantInteractionTransport,
} from '@wegent/collaboration'

function fixture(kind: AssistantEndpointKind) {
  const endpoint: AssistantEndpoint = {
    id: 'owner-role',
    kind,
    ownerUserId: 7,
    displayName: 'Assistant',
    availability: 'online',
    capabilities: { attachments: true, cancel: true, trace: true, models: [], skills: [] },
  }
  const conversation: AssistantConversation = {
    id: 'persisted-conversation',
    projectId: 'project',
    issueId: 'ISSUE-1',
    ownerUserId: 7,
    endpointId: endpoint.id,
    address: { deviceId: 'device', taskId: 'original-task' },
  }
  const request: AssistantInteractionRequest = {
    requestId: 'request',
    idempotencyKey: 'durable-request-key',
    projectId: 'project',
    issueId: 'ISSUE-1',
    senderUserId: 7,
    visibility: 'private',
    message: 'Continue investigation',
  }
  const sendRuntimeMessage = vi.fn(async () => ({ accepted: true, taskId: 'original-task' }))
  const cancelRuntimeTask = vi.fn(async () => ({ accepted: true }))
  const getRuntimeTranscript = vi.fn(async () => ({
    taskId: 'original-task',
    runtime: 'codex' as const,
    workspacePath: '',
    messages: [],
    turns: [],
  }))
  const transport: AssistantInteractionTransport = {
    sendRuntimeMessage,
    cancelRuntimeTask,
    getRuntimeTranscript,
  }
  return {
    endpoint,
    conversation,
    request,
    transport,
    sendRuntimeMessage,
    cancelRuntimeTask,
    getRuntimeTranscript,
  }
}

describe.each(['local_wework', 'cloud_device', 'wegent_agent'] as const)(
  '%s assistant contract',
  kind => {
    it('sends and resumes the original task with the durable key and private context', async () => {
      const f = fixture(kind)
      const interaction = createAssistantInteraction(f.endpoint, f.conversation, f.transport)
      expect(await interaction.send(f.request)).toEqual({
        conversationId: 'persisted-conversation',
        requestId: 'request',
        state: 'accepted',
      })
      await interaction.resume(f.request)
      expect(f.sendRuntimeMessage).toHaveBeenCalledTimes(2)
      expect(f.sendRuntimeMessage).toHaveBeenLastCalledWith({
        address: f.conversation.address,
        message: f.request.message,
        clientUserMessageId: f.request.idempotencyKey,
        attachmentIds: undefined,
        conversationContext: 'private_discussion',
        queueIfBusy: true,
      })
      await interaction.history()
      expect(f.getRuntimeTranscript).toHaveBeenCalledWith(f.conversation.address)
      expect(await interaction.cancel()).toEqual({
        conversationId: 'persisted-conversation',
        state: 'cancelled',
      })
    })

    it('reports queued acceptance without claiming the turn has started', async () => {
      const f = fixture(kind)
      f.sendRuntimeMessage.mockResolvedValueOnce({
        accepted: true,
        taskId: 'original-task',
        status: 'queued',
      })
      const interaction = createAssistantInteraction(f.endpoint, f.conversation, f.transport)

      await expect(interaction.send(f.request)).resolves.toMatchObject({
        state: 'accepted',
        queued: true,
      })
    })

    it('projects one ordered asynchronous envelope after acceptance', async () => {
      const f = fixture(kind)
      f.getRuntimeTranscript.mockResolvedValue({
        taskId: 'original-task',
        runtime: 'codex',
        workspacePath: '',
        running: true,
        acceptedClientUserMessageIds: ['durable-request-key'],
        messages: [
          {
            id: 'request',
            role: 'user',
            content: 'Continue investigation',
            clientUserMessageId: 'durable-request-key',
            turnId: 'turn-1',
            blocks: [
              {
                id: 'question',
                type: 'text',
                renderPayload: { interactionStatus: 'pending' },
              },
              { id: 'tool', type: 'tool', tool_name: 'read_file' },
            ],
          },
        ],
        turns: [
          {
            id: 'turn-1',
            status: 'running',
            items: [
              {
                id: 'answer',
                type: 'assistant_text',
                content: 'Draft answer',
              },
            ],
          },
        ],
      })
      const interaction = createAssistantInteraction(f.endpoint, f.conversation, f.transport)

      await interaction.send(f.request)
      await expect(interaction.events(f.request.requestId, 'trace-ref')).resolves.toEqual([
        expect.objectContaining({ state: 'request', sequence: 1 }),
        expect.objectContaining({ state: 'accepted', sequence: 2 }),
        expect.objectContaining({ state: 'needs_input', sequence: 3 }),
        expect.objectContaining({ state: 'draft', summary: 'Draft answer', sequence: 4 }),
        expect.objectContaining({ state: 'evidence', sequence: 5 }),
        expect.objectContaining({ state: 'trace', traceRef: 'trace-ref', sequence: 6 }),
      ])
    })

    it('never projects a missing request onto the latest unrelated turn', async () => {
      const f = fixture(kind)
      f.getRuntimeTranscript.mockResolvedValue({
        taskId: 'original-task',
        runtime: 'codex',
        workspacePath: '',
        acceptedClientUserMessageIds: [],
        messages: [
          {
            id: 'other-request',
            role: 'user',
            content: 'Another request',
            clientUserMessageId: 'another-key',
            turnId: 'other-turn',
          },
        ],
        turns: [
          {
            id: 'other-turn',
            status: 'completed',
            items: [
              {
                id: 'other-answer',
                type: 'assistant_text',
                content: 'Unrelated answer',
              },
            ],
          },
        ],
      })
      const interaction = createAssistantInteraction(f.endpoint, f.conversation, f.transport)

      await interaction.send(f.request)
      await expect(interaction.events(f.request.requestId)).resolves.toEqual([
        expect.objectContaining({ state: 'request', sequence: 1 }),
      ])
    })

    it('retains identity after routing to another device', async () => {
      const f = fixture(kind)
      const moved = {
        ...f.conversation,
        address: { ...f.conversation.address, deviceId: 'new-device' },
      }
      const interaction = createAssistantInteraction(f.endpoint, moved, f.transport)
      expect((await interaction.resume(f.request)).conversationId).toBe(f.conversation.id)
      expect(f.sendRuntimeMessage.mock.calls[0]).toEqual([
        expect.objectContaining({ address: moved.address }),
      ])
    })

    it('forwards interrupt intent instead of preserving the busy queue', async () => {
      const f = fixture(kind)
      const interaction = createAssistantInteraction(f.endpoint, f.conversation, f.transport)
      await interaction.send({ ...f.request, interruptWhenBusy: true })
      expect(f.sendRuntimeMessage).toHaveBeenCalledWith(
        expect.objectContaining({ interruptWhenBusy: true, queueIfBusy: false })
      )
    })

    it('rejects cross-owner and cross-Issue requests before calling a provider', async () => {
      const f = fixture(kind)
      const interaction = createAssistantInteraction(f.endpoint, f.conversation, f.transport)
      await expect(interaction.send({ ...f.request, senderUserId: 8 })).rejects.toMatchObject({
        code: 'scope_mismatch',
      })
      await expect(interaction.send({ ...f.request, issueId: 'OTHER' })).rejects.toMatchObject({
        code: 'scope_mismatch',
      })
      expect(f.sendRuntimeMessage).not.toHaveBeenCalled()
    })

    it('rejects unavailable capabilities without silently dropping the request', async () => {
      const f = fixture(kind)
      f.endpoint.capabilities.attachments = false
      f.endpoint.capabilities.cancel = false
      f.endpoint.capabilities.trace = false
      const interaction = createAssistantInteraction(f.endpoint, f.conversation, f.transport)
      await expect(interaction.send({ ...f.request, attachmentIds: [1] })).rejects.toMatchObject({
        code: 'unsupported_attachments',
      })
      await expect(interaction.cancel()).rejects.toMatchObject({ code: 'unsupported_cancel' })
      await interaction.send(f.request)
      await expect(interaction.events(f.request.requestId, 'trace-ref')).rejects.toMatchObject({
        code: 'unsupported_trace',
      })
      expect(f.sendRuntimeMessage).toHaveBeenCalledOnce()
      expect(f.cancelRuntimeTask).not.toHaveBeenCalled()
    })

    it('does not attach unavailable history to another similar task', async () => {
      const f = fixture(kind)
      f.getRuntimeTranscript.mockResolvedValue({
        taskId: 'different-task',
        runtime: 'codex',
        workspacePath: '',
        messages: [],
        turns: [],
      })
      const interaction = createAssistantInteraction(f.endpoint, f.conversation, f.transport)
      await expect(interaction.history()).rejects.toMatchObject({ code: 'history_unavailable' })
      expect(f.getRuntimeTranscript).toHaveBeenCalledTimes(1)
    })

    it('rejects a runtime response that drifts to another task', async () => {
      const f = fixture(kind)
      f.sendRuntimeMessage.mockResolvedValue({ accepted: true, taskId: 'other-task' })
      const interaction = createAssistantInteraction(f.endpoint, f.conversation, f.transport)
      await expect(interaction.send(f.request)).rejects.toMatchObject({
        code: 'request_rejected',
      })
    })
  }
)

describe('assistant endpoint adapters', () => {
  it.each([
    ['local_wework', localWeworkEndpoint],
    ['cloud_device', cloudDeviceEndpoint],
    ['wegent_agent', wegentAgentEndpoint],
  ] as const)('%s uses the same stable owner-and-role identity', (kind, factory) => {
    const endpointRef = kind === 'wegent_agent' ? `${kind}:7:agent-1:review` : undefined
    const endpoint = factory({
      ownerUserId: 7,
      roleId: 'review',
      displayName: 'Review assistant',
      ...(endpointRef ? { endpointRef } : {}),
    })
    expect(endpoint).toMatchObject({
      id: endpointRef ?? `${kind}:7:review`,
      kind,
      ownerUserId: 7,
    })
    expect(
      createAssistantConversation(endpoint, {
        id: 'persisted-conversation',
        projectId: 'project',
        issueId: 'ISSUE-1',
        deviceId: 'new-device',
        taskId: 'original-task',
      })
    ).toMatchObject({
      id: 'persisted-conversation',
      endpointId: endpoint.id,
      address: { deviceId: 'new-device', taskId: 'original-task' },
    })
  })

  it('bridges the existing Runtime operations without creating a second store', async () => {
    const send = vi.fn(async () => ({ accepted: true, taskId: 'task' }))
    const cancel = vi.fn(async () => false)
    const transcript = vi.fn(async (address: { deviceId: string; taskId: string }) => ({
      taskId: address.taskId,
      runtime: 'codex' as const,
      workspacePath: '',
      messages: [],
      turns: [],
    }))
    const transport = createRuntimeAssistantTransport({ send, cancel, transcript })
    const address = { deviceId: 'device', taskId: 'task' }
    await expect(
      transport.sendRuntimeMessage({
        address,
        message: 'Continue',
        clientUserMessageId: 'durable',
        conversationContext: 'private_discussion',
        queueIfBusy: true,
      })
    ).resolves.toEqual({ accepted: true, taskId: 'task' })
    await expect(transport.cancelRuntimeTask(address)).resolves.toEqual({ accepted: false })
    await expect(transport.getRuntimeTranscript(address)).resolves.toMatchObject({ taskId: 'task' })
    expect(send).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
    expect(transcript).toHaveBeenCalledWith(address)
  })

  it('rejects an incomplete Runtime address before creating a conversation', () => {
    const endpoint = localWeworkEndpoint({
      ownerUserId: 7,
      roleId: 'review',
      displayName: 'Review assistant',
    })
    expect(() =>
      createAssistantConversation(endpoint, {
        id: 'conversation',
        projectId: 'project',
        issueId: 'ISSUE-1',
        deviceId: 'device',
        taskId: '',
      })
    ).toThrow('Assistant conversation scope is required')
  })

  it('rejects endpoint references that claim another owner or role', () => {
    const input = { ownerUserId: 7, roleId: 'review', displayName: 'Reviewer' }
    expect(() => localWeworkEndpoint({ ...input, endpointRef: 'local_wework:8:review' })).toThrow(
      'does not match its owner and role'
    )
    expect(() =>
      wegentAgentEndpoint({
        ...input,
        endpointRef: 'wegent_agent:7:agent-1:other',
      })
    ).toThrow('does not match its owner and role')
  })

  it('projects a roster record into the shared endpoint capability contract', () => {
    expect(
      assistantEndpointFromRoster({
        endpointRef: 'wegent_agent:7:agent-1:review',
        userId: 7,
        roleId: 'review',
        endpointKind: 'wegent_agent',
        displayName: 'Review assistant',
        availability: 'online',
        capabilityTags: ['review', 'security'],
      })
    ).toMatchObject({
      id: 'wegent_agent:7:agent-1:review',
      ownerUserId: 7,
      capabilities: { skills: ['review', 'security'] },
    })
  })
})
