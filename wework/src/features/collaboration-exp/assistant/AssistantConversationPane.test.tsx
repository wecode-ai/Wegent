import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantConversationPane } from './AssistantConversationPane'
import { experienceRuntimeFixture, experienceStandInFixture } from '../model/fixtures'
import { recordAcceptedAssistantConversation } from './acceptedAssistantConversations'
import type { RuntimeWorkListResponse } from '@/types/api'

const mocks = vi.hoisted(() => ({
  runtimeWork: null as RuntimeWorkListResponse | null,
  userId: 7,
  renderChat: vi.fn(),
}))
const address = { deviceId: 'device-1', taskId: 'stand-in-chat-7-primary' }

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/features/cloud-connection/useCloudConnection', () => ({
  useOptionalCloudConnection: () => ({
    isConnected: false,
    serviceKey: 'local',
    apiBaseUrl: '',
    user: null,
  }),
}))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({
    state: { user: { id: mocks.userId }, runtimeWork: mocks.runtimeWork },
    refreshWorkLists: vi.fn().mockResolvedValue(undefined),
  }),
}))
vi.mock('./useAssistantSources', () => ({
  useAssistantSources: () => ({
    settings: experienceStandInFixture(),
    ownerId: mocks.userId,
    deviceId: 'device-1',
    inbox: { items: [], refresh: vi.fn() },
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}))
vi.mock('@/components/layout/workspace-panels/TemporaryChatPanel', () => ({
  TemporaryChatPanel: (props: Record<string, unknown>) => {
    mocks.renderChat(props)
    return <div data-testid="verified-native-chat" />
  },
}))

beforeEach(() => {
  localStorage.clear()
  mocks.runtimeWork = null
  mocks.userId = 7
  mocks.renderChat.mockClear()
})
afterEach(cleanup)

describe('AssistantConversationPane', () => {
  it('does not mount any history reader for an unverified URL-only task address', () => {
    mocks.runtimeWork = experienceRuntimeFixture([])
    render(
      <AssistantConversationPane
        active
        address={{ deviceId: 'device-1', taskId: 'unproven-url-task' }}
      />
    )
    expect(
      screen.getByTestId('collaboration-exp-assistant-conversation-unavailable')
    ).toBeInTheDocument()
    expect(mocks.renderChat).not.toHaveBeenCalled()
  })

  it('mounts the existing native panel with only the verified metadata address', () => {
    mocks.runtimeWork = experienceRuntimeFixture([
      {
        taskId: address.taskId,
        threadId: 'original-thread',
        runtimeHandle: {
          origin: {
            type: 'stand_in_identity',
            initiatedBy: 'stand_in_identity',
            userId: 7,
            deviceId: 'device-1',
            runtimeTaskId: address.taskId,
            standInId: null,
          },
        },
      },
    ])
    render(<AssistantConversationPane active address={address} />)
    expect(screen.getByTestId('verified-native-chat')).toBeInTheDocument()
    expect(mocks.renderChat.mock.calls[0][0]).toMatchObject({
      source: { ...address, threadId: 'original-thread' },
      controlledAddress: { ...address, threadId: 'original-thread' },
      sendEphemeral: false,
      nativeConversation: true,
    })
  })

  it('opens a newly accepted response before catalog refresh and never reuses it under another account', () => {
    const acceptedAddress = { deviceId: 'device-1', taskId: 'accepted-before-refresh' }
    recordAcceptedAssistantConversation(
      JSON.stringify(['', 7]),
      7,
      acceptedAddress,
      'Fresh question'
    )
    const view = render(<AssistantConversationPane active address={acceptedAddress} />)
    expect(screen.getByTestId('verified-native-chat')).toBeInTheDocument()
    mocks.userId = 8
    view.rerender(<AssistantConversationPane active address={acceptedAddress} />)
    expect(screen.queryByTestId('verified-native-chat')).not.toBeInTheDocument()
  })
})
