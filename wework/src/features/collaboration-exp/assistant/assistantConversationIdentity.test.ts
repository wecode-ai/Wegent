import { describe, expect, it } from 'vitest'
import {
  selectAssistantConversation,
  selectAssistantConversations,
  type AssistantConversationSource,
} from './assistantConversationIdentity'
import {
  acceptedAssistantConversation,
  recordAcceptedAssistantConversation,
} from './acceptedAssistantConversations'
import { experienceRuntimeFixture } from '../model/fixtures'
import type { StandInInboxWork } from '@/api/standIn'

const address = { deviceId: 'device-1', taskId: 'stand-in-chat-7-primary' }
const origin = {
  type: 'stand_in_identity',
  initiatedBy: 'stand_in_identity',
  userId: 7,
  deviceId: 'device-1',
  standInId: null,
  runtimeTaskId: address.taskId,
}

function source(overrides: Partial<AssistantConversationSource> = {}): AssistantConversationSource {
  return {
    ownerUserId: 7,
    inboxDeviceId: 'device-1',
    inbox: [],
    runtimeWork: experienceRuntimeFixture([
      {
        taskId: address.taskId,
        title: 'Default assistant',
        threadId: 'native-thread',
        updatedAt: 1730000000000,
        runtimeHandle: { origin },
      },
    ]),
    ...overrides,
  }
}

describe('assistant private conversation ownership', () => {
  it.each([
    ['@primary', 'stand-in-chat-7-primary', true],
    ['default', 'stand-in-chat-7-role-default', true],
    ['default', 'stand-in-chat-7-primary', false],
    ['@primary', 'stand-in-chat-7-role-default', false],
  ] as const)(
    'validates delegated %s work against its exact native source %s',
    (standInId, sourceTaskId, expected) => {
      const delegatedAddress = { deviceId: 'device-1', taskId: 'delegated-task' }
      const delegatedOrigin = {
        ...origin,
        type: 'stand_in_task',
        initiatedBy: 'stand_in',
        standInId,
        sourceTaskId,
      }
      const owned = source({
        runtimeWork: experienceRuntimeFixture([
          {
            taskId: delegatedAddress.taskId,
            title: 'Delegated work',
            runtimeHandle: { origin: delegatedOrigin },
          },
        ]),
      })
      const selected = selectAssistantConversation(owned, delegatedAddress)
      expect(Boolean(selected)).toBe(expected)
      expect(selectAssistantConversations(owned)).toEqual(selected ? [selected] : [])
      expect(selectAssistantConversation({ ...owned, ownerUserId: 8 }, delegatedAddress)).toBeNull()
    }
  )

  it('restores only an exact current owned native identity and uses its real thread and timestamp', () => {
    const selected = selectAssistantConversation(source(), address)
    expect(selected?.address).toMatchObject({
      ...address,
      threadId: 'native-thread',
      runtime: 'codex',
    })
    expect(selected?.linkedAt).toBe(new Date(1730000000000).toISOString())
    expect(selectAssistantConversation(source(), { ...address, taskId: 'unknown-task' })).toBeNull()
    expect(
      selectAssistantConversation(source(), { ...address, deviceId: 'different-device' })
    ).toBeNull()
    expect(selectAssistantConversations(source())).toEqual([selected])
  })

  it('rejects other owners and contradictory metadata even for a matching task ID', () => {
    const otherOwner = source({
      runtimeWork: experienceRuntimeFixture([
        { taskId: address.taskId, runtimeHandle: { origin: { ...origin, userId: 8 } } },
      ]),
    })
    expect(selectAssistantConversation(otherOwner, address)).toBeNull()
    const wrongDevice = source({
      runtimeWork: experienceRuntimeFixture([
        {
          taskId: address.taskId,
          runtimeHandle: { origin: { ...origin, deviceId: 'other-device' } },
        },
      ]),
    })
    expect(selectAssistantConversation(wrongDevice, address)).toBeNull()
  })

  it('keeps Issue-bound conversations on the existing project/private boundary', () => {
    const linked = source({
      runtimeWork: experienceRuntimeFixture([
        {
          taskId: address.taskId,
          runtimeHandle: {
            origin: { ...origin, cloudProjectId: 'project-1', loopItemId: 'EXP-1' },
          },
        },
      ]),
    })
    linked.inbox = [{ taskId: address.taskId, title: 'Linked work' } as StandInInboxWork]
    expect(selectAssistantConversation(linked, address)).toBeNull()
    expect(selectAssistantConversations(linked)).toEqual([])
  })

  it('accepts a private item from the exact current owner-scoped inbox without guessing another device', () => {
    const inbox: StandInInboxWork[] = [
      {
        taskId: 'inbox-task',
        title: 'Inbox private work',
        updatedAt: '2026-11-01T00:00:00Z',
      } as StandInInboxWork,
    ]
    expect(
      selectAssistantConversation(source({ runtimeWork: null, inbox }), {
        deviceId: 'device-1',
        taskId: 'inbox-task',
      })?.title
    ).toBe('Inbox private work')
    expect(
      selectAssistantConversation(source({ runtimeWork: null, inbox }), {
        deviceId: 'device-2',
        taskId: 'inbox-task',
      })
    ).toBeNull()
  })

  it('uses an accepted service response until metadata arrives while isolating accounts and rejecting conflicting native origins', () => {
    const account = 'accepted-current-account'
    const accepted = recordAcceptedAssistantConversation(account, 7, address, 'Accepted question')
    expect(acceptedAssistantConversation('other-account', address)).toBeNull()
    expect(acceptedAssistantConversation(account, address)).toEqual(accepted)
    expect(
      selectAssistantConversation(source({ runtimeWork: null, accepted }), address)?.title
    ).toBe('Accepted question')
    expect(selectAssistantConversation(source({ runtimeWork: null }), address)).toBeNull()
    expect(
      selectAssistantConversation(source({ ownerUserId: 8, runtimeWork: null, accepted }), address)
    ).toBeNull()
    const conflicting = source({
      accepted,
      runtimeWork: experienceRuntimeFixture([
        {
          taskId: address.taskId,
          runtimeHandle: { origin: { ...origin, cloudProjectId: 'foreign-project' } },
        },
      ]),
    })
    expect(selectAssistantConversation(conflicting, address)).toBeNull()
  })
})
