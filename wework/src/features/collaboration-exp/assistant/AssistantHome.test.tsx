import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState, type ComponentProps } from 'react'
import { newStandInRole } from '@/api/personalStandIn'
import type { RuntimeWorkListResponse } from '@/types/api'
import type { RuntimeWorkLoadState } from '@/types/workbench'
import { collectRuntimeTaskReminderItems } from '@/features/workbench/runtimeTaskReminders'
import { AssistantHome } from './AssistantHome'
import { AssistantHomeToolbar } from './AssistantHomeToolbar'
import { AssistantComposer } from './AssistantComposer'
import { AssistantTeam } from './AssistantTeam'
import { AssistantTeamRelay } from './AssistantTeamRelay'
import {
  experienceHumanRequestFixture,
  experienceIssueFixture,
  experienceProjectFixture,
  experienceStandInFixture,
} from '../model/fixtures'
import type { ExperiencePrivateConversation } from '../model'
import type { AssistantHomePanel } from './types'
import type { BufferedChatInput } from '@/components/layout/BufferedChatInput'
import type { useAssistantSources } from './useAssistantSources'

const mocks = vi.hoisted(() => ({
  workbench: {} as Record<string, unknown>,
  source: {} as ReturnType<typeof useAssistantSources>,
  attachments: {} as Record<string, unknown>,
  controls: {} as Record<string, unknown>,
  navigate: vi.fn(),
}))

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))
vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => mocks.workbench }))
vi.mock('./useAssistantSources', () => ({ useAssistantSources: () => mocks.source }))
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => mocks.navigate(...args) }))
vi.mock('@/features/workbench/useWorkbenchAttachments', () => ({
  useWorkbenchAttachments: () => mocks.attachments,
}))
vi.mock('@/features/todo/useStandInConversationModel', () => ({
  useStandInConversationModel: () => mocks.controls,
}))
vi.mock('@/components/layout/BufferedChatInput', () => ({
  BufferedChatInput: (props: ComponentProps<typeof BufferedChatInput>) => (
    <>
      <textarea
        data-testid={props.inputTestId}
        value={props.value}
        disabled={props.disabled}
        onChange={event => {
          props.onDraftEdit?.(event.target.value)
          props.onChange(event.target.value)
        }}
      />
      <button
        data-testid={props.submitButtonTestId}
        disabled={props.disabled || props.submitDisabled}
        onClick={() => void props.onSubmit(props.value)}
      >
        Send
      </button>
      {props.error && <p role="alert">{props.error}</p>}
      {props.toolbarLeadingContext}
    </>
  ),
}))

const settings = experienceStandInFixture()
const conversation: ExperiencePrivateConversation = {
  key: 'private-identity',
  ownerUserId: 7,
  bindingIds: ['binding-one'],
  sourceNodeIds: ['node-one'],
  address: {
    deviceId: 'device-1',
    taskId: 'existing-private-task',
    runtime: 'codex',
    threadId: 'original-thread',
  },
  title: 'Original private discussion',
  linkedAt: '2026-11-01T00:00:00Z',
}

function setupWorkbench() {
  const inputByScope: Record<string, string> = {}
  const api = {
    conversation: vi.fn().mockResolvedValue({ deviceId: 'device-1', taskId: 'new-private-task' }),
    personalSave: vi.fn().mockResolvedValue(settings),
    resolveProposal: vi.fn().mockResolvedValue(settings),
  }
  const createIssue = vi.fn()
  const projectChat = {
    inputByScope,
    setInputForScope: vi.fn((key: string, value: string) => {
      inputByScope[key] = value
    }),
    models: [],
    selectedModel: null,
    selectedModelOptions: {},
    selectedSkills: [],
    skills: [],
    trialTemplates: [],
  }
  const state = {
    user: { id: 7 },
    runtimeWork: { projects: [], chats: [], totalTasks: 0 } as RuntimeWorkListResponse | null,
    runtimeWorkLoad: { phase: 'ready', error: null } as RuntimeWorkLoadState,
  }
  const reminders = { items: collectRuntimeTaskReminderItems(state.runtimeWork) }
  const refreshWorkLists = vi.fn().mockResolvedValue(undefined)
  mocks.workbench = {
    state,
    services: { standInApi: api, sharedWorkspaceApi: { issues: { create: createIssue } } },
    projectChat,
    runtimeTaskReminders: reminders,
    openRuntimeTask: vi.fn(),
    refreshWorkLists,
  }
  mocks.attachments = {
    attachments: [],
    isAttachmentReadyToSend: true,
    errors: new Map(),
    uploadingFiles: new Map(),
    resetAttachments: vi.fn(),
  }
  mocks.controls = {
    models: [],
    selectedModel: null,
    selectedModelOptions: {},
    loading: false,
    unavailable: false,
  }
  mocks.source = {
    settings,
    ownerId: 7,
    userId: 7,
    deviceId: 'device-1',
    localDeviceId: 'device-1',
    scope: '[7,""]',
    proposals: [],
    proposalsReady: true,
    inboxReady: true,
    loading: false,
    error: null,
    inbox: { items: [], sourceErrors: [], error: null, refresh: vi.fn() },
    refresh: vi.fn(),
  }
  return { api, createIssue, projectChat, state, reminders, refreshWorkLists }
}

function runningCatalog(publicExecution = false): RuntimeWorkListResponse {
  return {
    projects: [],
    totalTasks: 1,
    chats: [
      {
        deviceId: 'device-1',
        workspacePath: '',
        available: true,
        tasks: [
          {
            taskId: 'native-running',
            title: 'Native running work',
            runtime: 'codex',
            workspacePath: '',
            status: 'running',
            running: true,
            runtimeHandle: {
              origin: {
                initiatedBy: 'stand_in',
                standInId: '@primary',
                userId: 7,
                deviceId: 'device-1',
                ...(publicExecution
                  ? {
                      type: 'issue_dispatch',
                      publicConversation: true,
                      cloudProjectId: 'real-project',
                      loopItemId: 'real-issue',
                      projectStore: 'local',
                    }
                  : {}),
              },
            },
          },
        ],
      },
    ],
  }
}

beforeEach(() => {
  localStorage.clear()
  setupWorkbench()
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('AssistantHome', () => {
  it('opens recent discussions and team management only through the shared header actions', () => {
    const { api, createIssue } = setupWorkbench()
    const openConversation = vi.fn()
    function Surface() {
      const [panel, setPanel] = useState<AssistantHomePanel>(null)
      return (
        <>
          <AssistantHomeToolbar panel={panel} onPanelChange={setPanel} />
          <AssistantHome
            active
            panel={panel}
            onPanelChange={setPanel}
            conversations={[conversation]}
            onOpenConversation={openConversation}
          />
        </>
      )
    }
    render(<Surface />)
    expect(screen.queryByTestId('collaboration-exp-recent-discussions')).not.toBeInTheDocument()
    expect(screen.queryByTestId('collaboration-exp-assistant-team')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('collaboration-exp-assistant-toolbar-recent'))
    fireEvent.click(screen.getByText('Original private discussion'))
    expect(openConversation).toHaveBeenCalledWith(conversation)
    fireEvent.click(screen.getByTestId('collaboration-exp-assistant-toolbar-team'))
    expect(screen.queryByTestId('collaboration-exp-recent-discussions')).not.toBeInTheDocument()
    expect(screen.getByTestId('collaboration-exp-assistant-team')).toBeInTheDocument()
    expect(api.conversation).not.toHaveBeenCalled()
    expect(createIssue).not.toHaveBeenCalled()
  })
  it.each(['loading', 'error'] as const)(
    'does not infer an idle team from an initially %s native catalog and retries all sources',
    async phase => {
      const { state, reminders, refreshWorkLists, api, createIssue } = setupWorkbench()
      state.runtimeWork = null
      state.runtimeWorkLoad = {
        phase,
        error: phase === 'error' ? 'Native catalog unavailable' : null,
      }
      reminders.items = collectRuntimeTaskReminderItems(state.runtimeWork)
      const openConversation = vi.fn()
      const content = (
        <>
          <AssistantHome
            active
            panel="recent"
            conversations={[conversation]}
            onOpenConversation={openConversation}
          />
          <AssistantTeamRelay active projects={[]} />
        </>
      )
      const view = render(content)
      for (const node of screen.getAllByTestId('collaboration-exp-team-relay-node-@primary'))
        expect(node).toHaveAttribute('data-state', 'unknown')
      expect(screen.getByTestId('collaboration-exp-assistant-count-running')).toHaveTextContent('—')
      fireEvent.click(screen.getByText('Original private discussion'))
      expect(openConversation).toHaveBeenCalledWith(conversation)
      if (phase === 'error') {
        fireEvent.click(screen.getByTestId('collaboration-exp-assistant-retry'))
        fireEvent.click(screen.getByTestId('collaboration-exp-team-relay-retry'))
        expect(refreshWorkLists).toHaveBeenCalledTimes(2)
        expect(mocks.source.refresh).toHaveBeenCalledTimes(2)
        expect(mocks.source.inbox.refresh).toHaveBeenCalledTimes(2)
      }
      state.runtimeWork = runningCatalog()
      state.runtimeWorkLoad = { phase: 'ready', error: null }
      reminders.items = collectRuntimeTaskReminderItems(state.runtimeWork)
      view.rerender(
        <>
          <AssistantHome
            active
            panel="recent"
            conversations={[conversation]}
            onOpenConversation={openConversation}
          />
          <AssistantTeamRelay active projects={[]} />
        </>
      )
      for (const node of screen.getAllByTestId('collaboration-exp-team-relay-node-@primary'))
        expect(node).toHaveAttribute('data-state', 'running')
      expect(screen.getByTestId('collaboration-exp-assistant-count-running')).toHaveTextContent('1')
      expect(api.conversation).not.toHaveBeenCalled()
      expect(createIssue).not.toHaveBeenCalled()
    }
  )

  it('opens public Issue work through its original runtime address without a loaded Issue or discussion map', () => {
    const { state, reminders, api, createIssue } = setupWorkbench()
    state.runtimeWork = runningCatalog(true)
    reminders.items = collectRuntimeTaskReminderItems(state.runtimeWork)
    const openConversation = vi.fn()
    render(
      <AssistantHome
        active
        projects={[]}
        conversations={[]}
        onOpenConversation={openConversation}
      />
    )
    fireEvent.click(screen.getByTestId('collaboration-exp-assistant-current'))
    fireEvent.click(screen.getByTestId('collaboration-exp-assistant-work-native-running'))
    expect(mocks.workbench.openRuntimeTask).toHaveBeenNthCalledWith(1, reminders.items[0].address)
    expect(mocks.workbench.openRuntimeTask).toHaveBeenNthCalledWith(2, reminders.items[0].address)
    expect(openConversation).not.toHaveBeenCalled()
    expect(api.conversation).not.toHaveBeenCalled()
    expect(createIssue).not.toHaveBeenCalled()
  })

  it('shares real team states and work counts with the tasks relay without creating work', () => {
    const { api, createIssue } = setupWorkbench()
    mocks.source.settings = {
      ...settings,
      roles: [
        { ...newStandInRole('device-1', 'reviewer'), name: 'Reviewer', enabled: true },
        { ...newStandInRole('device-1', 'archivist'), name: 'Archivist', enabled: true },
      ],
    }
    mocks.source.inbox.items = [
      {
        id: 'waiting',
        taskId: 'waiting-task',
        roleId: '@primary',
        title: 'Choose release scope',
        status: 'pending',
        messageCount: 1,
        updatedAt: '2026-11-03T00:00:00Z',
        latestMessage: null,
        source: { id: 'source', name: 'Release group' } as never,
      },
      {
        id: 'running',
        taskId: 'running-task',
        roleId: 'reviewer',
        title: 'Review release changes',
        status: 'sending',
        messageCount: 1,
        updatedAt: '2026-11-03T00:00:00Z',
        latestMessage: null,
        source: { id: 'source', name: 'Release group' } as never,
      },
      {
        id: 'completed',
        taskId: 'completed-task',
        roleId: 'archivist',
        title: 'Archive previous release',
        status: 'sent',
        messageCount: 1,
        updatedAt: '2026-11-03T00:00:00Z',
        latestMessage: null,
        source: { id: 'source', name: 'Release group' } as never,
      },
    ]
    const openConversation = vi.fn()
    render(
      <>
        <AssistantHome active onOpenConversation={openConversation} />
        <AssistantTeamRelay active projects={[]} />
      </>
    )
    for (const relay of screen.getAllByTestId('collaboration-exp-team-relay')) {
      expect(
        within(relay).getByTestId('collaboration-exp-team-relay-node-@primary')
      ).toHaveAttribute('data-state', 'waiting')
      expect(
        within(relay).getByTestId('collaboration-exp-team-relay-node-reviewer')
      ).toHaveAttribute('data-state', 'running')
      expect(
        within(relay).getByTestId('collaboration-exp-team-relay-node-archivist')
      ).toHaveAttribute('data-state', 'idle')
      expect(
        within(relay).getByTestId('collaboration-exp-team-relay-node-archivist')
      ).toHaveAttribute('data-completed-count', '1')
    }
    expect(screen.getByTestId('collaboration-exp-assistant-count-waiting')).toHaveTextContent('1')
    expect(screen.getByTestId('collaboration-exp-assistant-count-running')).toHaveTextContent('1')
    expect(screen.getByTestId('collaboration-exp-assistant-count-completed')).toHaveTextContent('1')
    fireEvent.click(screen.getByTestId('collaboration-exp-assistant-current'))
    expect(openConversation).toHaveBeenCalledWith(
      expect.objectContaining({ address: { deviceId: 'device-1', taskId: 'running-task' } })
    )
    fireEvent.click(
      within(screen.getByTestId('collaboration-exp-connected-team-relay')).getByTestId(
        'collaboration-exp-team-relay-node-reviewer'
      )
    )
    expect(mocks.navigate).toHaveBeenCalledWith(expect.stringContaining('profileId=reviewer'))
    expect(api.conversation).not.toHaveBeenCalled()
    expect(api.personalSave).not.toHaveBeenCalled()
    expect(createIssue).not.toHaveBeenCalled()
  })

  it('does not turn unavailable assistant data into empty work counts', () => {
    mocks.source.settings = undefined
    mocks.source.error = 'Assistant unavailable'
    render(<AssistantHome active />)
    expect(screen.getByTestId('collaboration-exp-team-relay-unavailable')).toBeInTheDocument()
    expect(screen.queryByTestId('collaboration-exp-assistant-snapshot')).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('collaboration-exp-team-relay-node-@primary')
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('collaboration-exp-assistant-team-toggle')).toBeDisabled()
    expect(screen.getByTestId('collaboration-exp-assistant-retry')).toBeEnabled()
  })

  it('keeps team statuses unknown and counters unset until both work sources finish', () => {
    mocks.source.inboxReady = false
    mocks.source.proposalsReady = false
    const view = render(<AssistantHome active />)
    const node = screen.getByTestId('collaboration-exp-team-relay-node-@primary')
    expect(node).toHaveAttribute('data-state', 'unknown')
    expect(screen.getByTestId('collaboration-exp-assistant-count-waiting')).toHaveTextContent('—')
    mocks.source.inboxReady = true
    view.rerender(<AssistantHome active />)
    expect(node).toHaveAttribute('data-state', 'unknown')
    expect(screen.getByTestId('collaboration-exp-assistant-count-running')).toHaveTextContent('—')
    mocks.source.proposalsReady = true
    view.rerender(<AssistantHome active />)
    expect(screen.getByTestId('collaboration-exp-team-relay-node-@primary')).toBe(node)
    expect(node).toHaveAttribute('data-state', 'idle')
    expect(screen.getByTestId('collaboration-exp-assistant-count-running')).toHaveTextContent('0')
  })

  it('keeps unavailable tasks team configuration disabled instead of navigating with an empty device', () => {
    mocks.source.settings = undefined
    mocks.source.deviceId = undefined
    mocks.source.error = 'Assistant unavailable'
    render(<AssistantTeamRelay active projects={[]} />)
    expect(screen.getByTestId('collaboration-exp-team-relay-manage')).toBeDisabled()
    fireEvent.click(screen.getByTestId('collaboration-exp-team-relay-manage'))
    expect(mocks.navigate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('collaboration-exp-team-relay-retry'))
    expect(mocks.source.refresh).toHaveBeenCalled()
  })

  it('keeps a proven Issue discussion available when assistant settings fail to load', () => {
    const openConversation = vi.fn()
    const proven = {
      ...conversation,
      issueSource: { projectStore: 'backend' as const, projectId: 'project-1', issueId: 'EXP-1' },
    }
    mocks.source.settings = undefined
    mocks.source.error = 'Assistant settings unavailable'
    render(
      <AssistantHome
        active
        panel="recent"
        conversations={[proven]}
        onOpenConversation={openConversation}
      />
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Assistant settings unavailable')
    fireEvent.click(screen.getByText('Original private discussion'))
    expect(openConversation).toHaveBeenCalledWith(proven)
    expect(openConversation.mock.calls[0][0].address).toStrictEqual(conversation.address)
    expect(screen.queryByTestId('collaboration-exp-assistant-input')).not.toBeInTheDocument()
  })

  it('shows concrete existing decisions, recent private identity and running work', () => {
    const openIssue = vi.fn()
    const openConversation = vi.fn()
    mocks.source.proposals = [
      {
        id: 'proposal-one',
        roleId: null,
        summary: 'Connect the release calendar',
        settings,
        status: 'pending',
      },
    ]
    mocks.source.inbox.items = [
      {
        id: 'work-one',
        taskId: 'running-task',
        roleId: 'default',
        title: 'Prepare release summary',
        source: { id: 'source', name: 'Release group' } as never,
        status: 'sending',
        updatedAt: '2026-11-03T00:00:00Z',
        messageCount: 1,
        latestMessage: null,
        task: {
          taskId: 'running-task',
          title: 'Prepare release summary',
          runtime: 'codex',
          workspacePath: '',
          running: true,
          status: 'running',
          updatedAt: '2026-11-03T00:00:00Z',
        },
      },
    ]
    render(
      <AssistantHome
        active
        panel="recent"
        conversations={[conversation]}
        projects={[
          {
            project: experienceProjectFixture(),
            issues: [
              experienceIssueFixture({
                human_requests: [
                  experienceHumanRequestFixture({
                    id: 'other-user-request',
                    recipient_user_id: 8,
                    question: 'Someone else decides this',
                  }),
                  experienceHumanRequestFixture({ question: 'Choose the release scope' }),
                ],
              }),
            ],
          },
        ]}
        onOpenIssue={openIssue}
        onOpenConversation={openConversation}
      />
    )
    expect(screen.getByText('Connect the release calendar')).toBeInTheDocument()
    expect(screen.getByTestId('collaboration-exp-assistant-proposal-proposal-one')).toHaveAttribute(
      'data-state',
      'waiting'
    )
    expect(
      screen.getByTestId('collaboration-exp-assistant-proposal-proposal-one')
    ).toHaveTextContent('assistant.reviewProposal')
    fireEvent.click(screen.getByText('Choose the release scope'))
    expect(openIssue).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'project-1', store: 'backend' }),
      'EXP-1'
    )
    fireEvent.click(screen.getByText('Original private discussion'))
    expect(openConversation).toHaveBeenCalledWith(conversation)
    expect(openConversation.mock.calls[0][0].address).toStrictEqual(conversation.address)
    expect(
      within(screen.getByTestId('collaboration-exp-assistant-progress')).getByText(
        /assistant.status.running/
      )
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('collaboration-exp-assistant-work-running-task').querySelector('time')
    ).toHaveAttribute('datetime', '2026-11-03T00:00:00.000Z')
    expect(screen.queryByRole('banner')).not.toBeInTheDocument()
  })

  it('uses the same native work item recency for progress and omits unavailable timestamps', () => {
    const { state, reminders } = setupWorkbench()
    state.runtimeWork = runningCatalog()
    state.runtimeWork.chats![0].tasks[0].recencyAt = '2026-11-04T08:15:00Z'
    state.runtimeWork.chats![0].tasks[0].updatedAt = '2026-11-01T00:00:00Z'
    reminders.items = collectRuntimeTaskReminderItems(state.runtimeWork)
    const view = render(<AssistantHome active />)
    const row = screen.getByTestId('collaboration-exp-assistant-work-native-running')
    expect(row.querySelector('time')).toHaveAttribute('datetime', '2026-11-04T08:15:00.000Z')
    expect(row.querySelector('time')).not.toBeEmptyDOMElement()
    state.runtimeWork.chats![0].tasks[0].recencyAt = null
    state.runtimeWork.chats![0].tasks[0].updatedAt = null
    reminders.items = collectRuntimeTaskReminderItems(state.runtimeWork)
    view.rerender(<AssistantHome active />)
    expect(
      screen.getByTestId('collaboration-exp-assistant-work-native-running').querySelector('time')
    ).toBeNull()
  })

  it('keeps an unsent draft across inactive view switches without creating a private task or shared Issue', () => {
    const { api, createIssue, projectChat } = setupWorkbench()
    const props = { active: true, settings, onCreated: vi.fn() }
    const view = render(<AssistantComposer {...props} />)
    fireEvent.change(screen.getByTestId('collaboration-exp-assistant-input'), {
      target: { value: 'Unsent ordinary question' },
    })
    view.rerender(<AssistantComposer {...props} active={false} />)
    view.rerender(<AssistantComposer {...props} />)
    expect(screen.getByTestId('collaboration-exp-assistant-input')).toHaveValue(
      'Unsent ordinary question'
    )
    expect(Object.values(projectChat.inputByScope)).toContain('Unsent ordinary question')
    expect(api.conversation).not.toHaveBeenCalled()
    expect(createIssue).not.toHaveBeenCalled()
  })

  it('sends the first ordinary question through the existing private runtime API only', async () => {
    const { api, createIssue } = setupWorkbench()
    const onCreated = vi.fn()
    const props = { active: true, settings, onCreated }
    const view = render(<AssistantComposer {...props} />)
    fireEvent.change(screen.getByTestId('collaboration-exp-assistant-input'), {
      target: { value: 'Why did the build fail?' },
    })
    view.rerender(<AssistantComposer {...props} />)
    fireEvent.click(screen.getByTestId('collaboration-exp-assistant-send'))
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith(
        { deviceId: 'device-1', taskId: 'new-private-task' },
        'Why did the build fail?'
      )
    )
    expect(api.conversation).toHaveBeenCalledWith(
      7,
      'device-1',
      'Why did the build fail?',
      undefined,
      expect.objectContaining({ attachments: [], clientUserMessageId: expect.any(String) })
    )
    expect(createIssue).not.toHaveBeenCalled()
  })

  it('routes a selected specialist to its exact device and restores independent role drafts', async () => {
    const { api, createIssue } = setupWorkbench()
    const scopedSettings = {
      ...settings,
      roles: [{ ...newStandInRole('specialist-device', 'reviewer'), name: 'Reviewer' }],
    }
    const onCreated = vi.fn()
    api.conversation.mockResolvedValue({ deviceId: 'specialist-device', taskId: 'reviewer-task' })
    render(<AssistantComposer active settings={scopedSettings} onCreated={onCreated} />)
    const changeRole = (name: string) => {
      fireEvent.click(screen.getByTestId('collaboration-exp-assistant-role-select'))
      fireEvent.click(screen.getByRole('option', { name }))
    }
    fireEvent.change(screen.getByTestId('collaboration-exp-assistant-input'), {
      target: { value: 'Primary private draft' },
    })
    changeRole('Reviewer')
    expect(screen.getByTestId('collaboration-exp-assistant-input')).toHaveValue('')
    fireEvent.change(screen.getByTestId('collaboration-exp-assistant-input'), {
      target: { value: 'Review this plan' },
    })
    changeRole('assistant.automatic')
    expect(screen.getByTestId('collaboration-exp-assistant-input')).toHaveValue(
      'Primary private draft'
    )
    changeRole('Reviewer')
    expect(screen.getByTestId('collaboration-exp-assistant-input')).toHaveValue('Review this plan')
    fireEvent.click(screen.getByTestId('collaboration-exp-assistant-send'))
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith(
        { deviceId: 'specialist-device', taskId: 'reviewer-task' },
        'Review this plan'
      )
    )
    expect(api.conversation).toHaveBeenCalledWith(
      7,
      'specialist-device',
      'Review this plan',
      'reviewer',
      expect.objectContaining({ clientUserMessageId: expect.any(String) })
    )
    expect(createIssue).not.toHaveBeenCalled()
  })

  it('resets the selected role and hides its draft when the owner account changes', () => {
    const { api, state } = setupWorkbench()
    const scopedSettings = {
      ...settings,
      roles: [{ ...newStandInRole('specialist-device', 'reviewer'), name: 'Reviewer' }],
    }
    const view = render(<AssistantComposer active settings={scopedSettings} onCreated={vi.fn()} />)
    fireEvent.click(screen.getByTestId('collaboration-exp-assistant-role-select'))
    fireEvent.click(screen.getByRole('option', { name: 'Reviewer' }))
    fireEvent.change(screen.getByTestId('collaboration-exp-assistant-input'), {
      target: { value: 'First account private draft' },
    })
    state.user.id = 8
    view.rerender(
      <AssistantComposer active settings={{ ...scopedSettings, userId: 8 }} onCreated={vi.fn()} />
    )
    expect(screen.getByTestId('collaboration-exp-assistant-role-select')).toHaveTextContent(
      'assistant.automatic'
    )
    expect(screen.getByTestId('collaboration-exp-assistant-input')).toHaveValue('')
    expect(api.conversation).not.toHaveBeenCalled()
  })

  it('preserves the draft when the private runtime fails to send', async () => {
    const { api, projectChat } = setupWorkbench()
    api.conversation.mockRejectedValue(new Error('Device disconnected'))
    const props = { active: true, settings, onCreated: vi.fn() }
    const view = render(<AssistantComposer {...props} />)
    fireEvent.change(screen.getByTestId('collaboration-exp-assistant-input'), {
      target: { value: 'Keep this draft' },
    })
    view.rerender(<AssistantComposer {...props} />)
    fireEvent.click(screen.getByTestId('collaboration-exp-assistant-send'))
    await waitFor(() => expect(screen.getByRole('alert')).not.toBeEmptyDOMElement())
    expect(Object.values(projectChat.inputByScope)).toContain('Keep this draft')
    expect(props.onCreated).not.toHaveBeenCalled()
  })

  it.each(['A new unsent question', 'Original question'])(
    'preserves a newly edited draft across remount when an old send accepts: %s',
    async nextDraft => {
      const { api, projectChat } = setupWorkbench()
      let accept!: (address: { deviceId: string; taskId: string }) => void
      api.conversation.mockReturnValue(
        new Promise(resolve => {
          accept = resolve
        })
      )
      const props = { active: true, settings, onCreated: vi.fn() }
      const first = render(<AssistantComposer {...props} />)
      fireEvent.change(screen.getByTestId('collaboration-exp-assistant-input'), {
        target: { value: 'Original question' },
      })
      fireEvent.click(screen.getByTestId('collaboration-exp-assistant-send'))
      expect(api.conversation).toHaveBeenCalledTimes(1)
      first.unmount()
      const second = render(<AssistantComposer {...props} />)
      fireEvent.change(screen.getByTestId('collaboration-exp-assistant-input'), {
        target: { value: 'Intervening edit' },
      })
      fireEvent.change(screen.getByTestId('collaboration-exp-assistant-input'), {
        target: { value: nextDraft },
      })
      await act(async () => accept({ deviceId: 'device-1', taskId: 'accepted-old-question' }))
      expect(screen.getByTestId('collaboration-exp-assistant-input')).toHaveValue(nextDraft)
      expect(Object.values(projectChat.inputByScope)).toContain(nextDraft)
      expect(props.onCreated).not.toHaveBeenCalled()
      second.unmount()
      setupWorkbench()
      render(<AssistantComposer {...props} />)
      expect(screen.getByTestId('collaboration-exp-assistant-input')).toHaveValue(nextDraft)
    }
  )

  it('clears an unchanged restored draft when the original unmounted send accepts', async () => {
    const { api, projectChat } = setupWorkbench()
    let accept!: (address: { deviceId: string; taskId: string }) => void
    api.conversation.mockReturnValue(
      new Promise(resolve => {
        accept = resolve
      })
    )
    const props = { active: true, settings, onCreated: vi.fn() }
    const first = render(<AssistantComposer {...props} />)
    fireEvent.change(screen.getByTestId('collaboration-exp-assistant-input'), {
      target: { value: 'Accepted original question' },
    })
    fireEvent.click(screen.getByTestId('collaboration-exp-assistant-send'))
    first.unmount()
    const second = render(<AssistantComposer {...props} />)
    expect(screen.getByTestId('collaboration-exp-assistant-input')).toHaveValue(
      'Accepted original question'
    )
    await act(async () => accept({ deviceId: 'device-1', taskId: 'accepted-old-question' }))
    expect(screen.getByTestId('collaboration-exp-assistant-input')).toHaveValue('')
    expect(Object.values(projectChat.inputByScope)).not.toContain('Accepted original question')
    second.unmount()
    setupWorkbench()
    render(<AssistantComposer {...props} />)
    expect(screen.getByTestId('collaboration-exp-assistant-input')).toHaveValue('')
  })

  it('does not restore accepted text when completion happens entirely between assistant mounts', async () => {
    const { api } = setupWorkbench()
    let accept!: (address: { deviceId: string; taskId: string }) => void
    api.conversation.mockReturnValue(
      new Promise(resolve => {
        accept = resolve
      })
    )
    const props = { active: true, settings, onCreated: vi.fn() }
    const first = render(<AssistantComposer {...props} />)
    fireEvent.change(screen.getByTestId('collaboration-exp-assistant-input'), {
      target: { value: 'Already accepted while away' },
    })
    fireEvent.click(screen.getByTestId('collaboration-exp-assistant-send'))
    first.unmount()
    await act(async () => accept({ deviceId: 'device-1', taskId: 'accepted-while-away' }))
    render(<AssistantComposer {...props} />)
    expect(screen.getByTestId('collaboration-exp-assistant-input')).toHaveValue('')
    expect(props.onCreated).not.toHaveBeenCalled()
  })

  it('protects the default assistant and explains history retention before deleting a specialist', async () => {
    const role = { ...newStandInRole('device-1', 'reviewer'), name: 'Reviewer' }
    const onDelete = vi.fn().mockResolvedValue(true)
    render(
      <AssistantTeam
        settings={{ ...settings, roles: [role] }}
        projects={[]}
        onConfigure={vi.fn()}
        onDelete={onDelete}
      />
    )
    expect(
      within(screen.getByTestId('collaboration-exp-assistant-role-@primary')).queryByTestId(
        'collaboration-exp-assistant-delete-@primary'
      )
    ).not.toBeInTheDocument()
    expect(screen.getByText('assistant.defaultProtected')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('collaboration-exp-assistant-delete-reviewer'))
    expect(screen.getByRole('dialog')).toHaveTextContent('assistant.deleteRoleDescription')
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('collaboration-exp-assistant-delete-confirm'))
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(role))
  })

  it('removes only the confirmed specialist settings and preserves the primary assistant', async () => {
    const { api } = setupWorkbench()
    const role = { ...newStandInRole('device-1', 'reviewer'), name: 'Reviewer' }
    mocks.source.settings = { ...settings, roles: [role] }
    render(<AssistantHome active />)
    fireEvent.click(screen.getByTestId('collaboration-exp-assistant-team-toggle'))
    fireEvent.click(screen.getByTestId('collaboration-exp-assistant-delete-reviewer'))
    fireEvent.click(screen.getByTestId('collaboration-exp-assistant-delete-confirm'))
    await waitFor(() =>
      expect(api.personalSave).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ primary: settings.primary, roles: [] }),
        'device-1'
      )
    )
    expect(api.conversation).not.toHaveBeenCalled()
    expect(mocks.source.refresh).toHaveBeenCalled()
  })

  it('restores the ordinary-question draft after remounting without creating a conversation', () => {
    const { api } = setupWorkbench()
    const props = { active: true, settings, onCreated: vi.fn() }
    const view = render(<AssistantComposer {...props} />)
    fireEvent.change(screen.getByTestId('collaboration-exp-assistant-input'), {
      target: { value: 'Restore after restart' },
    })
    view.unmount()
    setupWorkbench()
    render(<AssistantComposer {...props} />)
    expect(screen.getByTestId('collaboration-exp-assistant-input')).toHaveValue(
      'Restore after restart'
    )
    expect(api.conversation).not.toHaveBeenCalled()
  })

  it('refuses a proposal that would pause the protected default assistant', async () => {
    const { api } = setupWorkbench()
    mocks.source.proposals = [
      {
        id: 'disable-primary',
        summary: 'Pause default assistant',
        status: 'pending',
        settings: { ...settings, primary: { ...settings.primary!, enabled: false } },
      },
    ]
    render(<AssistantHome active />)
    fireEvent.click(screen.getByTestId('collaboration-exp-assistant-proposal-disable-primary'))
    fireEvent.click(screen.getByTestId('stand-in-proposal-accept'))
    expect(screen.getByRole('alert')).toHaveTextContent('assistant.defaultProtected')
    expect(api.resolveProposal).not.toHaveBeenCalled()
  })
})
