import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { newStandInRole } from '@/api/personalStandIn'
import { AssistantHome } from './AssistantHome'
import { AssistantComposer } from './AssistantComposer'
import { AssistantTeam } from './AssistantTeam'
import {
  experienceHumanRequestFixture,
  experienceIssueFixture,
  experienceProjectFixture,
  experienceStandInFixture,
} from '../model/fixtures'
import type { ExperiencePrivateConversation } from '../model'
import type { BufferedChatInput } from '@/components/layout/BufferedChatInput'
import type { useAssistantSources } from './useAssistantSources'

const mocks = vi.hoisted(() => ({
  workbench: {} as Record<string, unknown>,
  source: {} as ReturnType<typeof useAssistantSources>,
  attachments: {} as Record<string, unknown>,
  controls: {} as Record<string, unknown>,
}))

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))
vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => mocks.workbench }))
vi.mock('./useAssistantSources', () => ({ useAssistantSources: () => mocks.source }))
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
  mocks.workbench = {
    state: { user: { id: 7 }, runtimeWork: null },
    services: { standInApi: api, sharedWorkspaceApi: { issues: { create: createIssue } } },
    projectChat,
    runtimeTaskReminders: { items: [] },
    openRuntimeTask: vi.fn(),
    refreshWorkLists: vi.fn().mockResolvedValue(undefined),
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
    loading: false,
    error: null,
    inbox: { items: [], sourceErrors: [], error: null, refresh: vi.fn() },
    refresh: vi.fn(),
  }
  return { api, createIssue, projectChat }
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
  it('keeps a proven Issue discussion available when assistant settings fail to load', () => {
    const openConversation = vi.fn()
    const proven = {
      ...conversation,
      issueSource: { projectStore: 'backend' as const, projectId: 'project-1', issueId: 'EXP-1' },
    }
    mocks.source.settings = undefined
    mocks.source.error = 'Assistant settings unavailable'
    render(<AssistantHome active conversations={[proven]} onOpenConversation={openConversation} />)
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
    expect(screen.queryByRole('banner')).not.toBeInTheDocument()
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
