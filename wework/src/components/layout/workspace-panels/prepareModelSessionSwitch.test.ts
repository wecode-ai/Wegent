import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTaskLifecycleSnapshot } from '@/features/workbench/runtimeTaskLifecycle'
import type { UnifiedModel } from '@/types/api'
import { prepareModelSessionSwitch } from './prepareModelSessionSwitch'

const deepseek: UnifiedModel = { name: 'deepseek', type: 'public', provider: 'cloud' }
const gpt: UnifiedModel = {
  name: 'gpt-6.1-sol',
  type: 'runtime',
  provider: 'local',
  config: { weworkModelKind: 'codex-official' },
}
const address = { deviceId: 'device', taskId: 'stand-in-chat-7-primary', threadId: 'stale-thread' }
const lifecycle = {
  address,
  task: { threadId: 'latest-thread', title: 'My stand-in' },
  interactionStatus: null,
  goalStatus: null,
} as RuntimeTaskLifecycleSnapshot

function setup() {
  return {
    address,
    lifecycle,
    activeModel: deepseek,
    selectedModel: gpt,
    busy: false,
    blockedMessage: 'blocked',
    unresolvedMessage: 'syncing',
    loadTranscript: vi
      .fn()
      .mockResolvedValue({ messages: [{ role: 'user', content: 'Old context' }] }),
  }
}

describe('prepareModelSessionSwitch', () => {
  it.each([
    [deepseek, gpt],
    [gpt, deepseek],
  ])(
    'bridges both provider directions as reference, not native history',
    async (activeModel, selectedModel) => {
      const options = {
        ...setup(),
        activeModel,
        selectedModel,
        additionalContext: { source: { kind: 'application' as const, value: 'keep' } },
      }
      const result = await prepareModelSessionSwitch(options)
      expect(result).toMatchObject({
        startNewSession: true,
        expectedThreadId: 'latest-thread',
        additionalContext: { source: { value: 'keep' } },
      })
      expect(options.loadTranscript).toHaveBeenCalledWith(
        expect.objectContaining({ ...address, threadId: 'latest-thread' }),
        expect.objectContaining({
          isolated: true,
          conversationContextOnly: true,
          includeFullContent: true,
        })
      )
      expect(result?.additionalContext?.referencedConversations.value).toContain(
        'untrusted background context'
      )
      expect(result?.additionalContext?.referencedConversations.value).toContain('Old context')
    }
  )

  it('does not split same-provider or unrecognized model transitions', async () => {
    const options = setup()
    expect(
      await prepareModelSessionSwitch({
        ...options,
        selectedModel: { ...deepseek, name: 'other-cloud-model' },
      })
    ).toBeNull()
    expect(await prepareModelSessionSwitch({ ...options, activeModel: null })).toBeNull()
    expect(options.loadTranscript).not.toHaveBeenCalled()
  })

  it.each([
    { busy: true },
    { lifecycle: { ...lifecycle, interactionStatus: 'awaitingUserReply' } },
    { lifecycle: { ...lifecycle, interactionStatus: 'waitingForUserInput' } },
    { lifecycle: { ...lifecycle, goalStatus: 'active' } },
  ] as Array<Partial<Parameters<typeof prepareModelSessionSwitch>[0]>>)(
    'preserves active execution and human decisions: %j',
    async overrides => {
      const options = { ...setup(), ...overrides }
      await expect(prepareModelSessionSwitch(options)).rejects.toThrow('blocked')
      expect(options.loadTranscript).not.toHaveBeenCalled()
    }
  )

  it('rejects unresolved threads and propagates context-load failure for retry', async () => {
    const options = setup()
    await expect(
      prepareModelSessionSwitch({
        ...options,
        lifecycle: null,
        address: { ...address, threadId: null },
      })
    ).rejects.toThrow('syncing')
    options.loadTranscript.mockRejectedValue(new Error('history unavailable'))
    await expect(prepareModelSessionSwitch(options)).rejects.toThrow('history unavailable')
  })
})
