import { createRuntimeConversationSession } from '@wegent/chat-core/runtime-conversation-session'
import {
  createQuickPhrasePreferencesStore,
  defaultQuickPhrases,
} from '@wegent/chat-core/composer-quick-phrases'
// @vitest-environment jsdom
import { act, useState, useMemo, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { BrowserTaskComposer } from './BrowserTaskComposer'
import { BrowserTaskDrafts } from './BrowserTaskDrafts'
import { useBrowserTaskDraft } from './browserTaskDraftContext'
import { createCollaborationTranslator } from '../i18n'
import type { SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'

const model = { name: 'gpt-5.6-sol', type: 'runtime' as const, displayName: 'GPT 5.6 Sol' }
const address = { deviceId: 'device-1', taskId: 'task-1' }
const emptyPluginSnapshot = {
  taskId: 'task-1',
  workspacePath: '/actual/workspace',
  projectPluginIds: [],
  apps: [],
  marketplaces: [],
  cloudInstalledPlugins: [],
  store: { storePath: '/store', plugins: [] },
}
const attachment = {
  id: 17,
  filename: 'context.bin',
  file_size: 4,
  file_extension: '.bin',
  mime_type: 'application/octet-stream',
  status: 'ready' as const,
  created_at: '',
  subtask_id: null,
}
const translate = createCollaborationTranslator('zh-CN')
const task = {
  taskId: 'task-1',
  workspacePath: '/actual/workspace',
  runtime: 'codex',
  title: 'pwd',
  modelSelection: {
    modelName: model.name,
    modelType: model.type,
    options: { reasoningEffort: 'high' },
  },
}

function Harness({
  runtime,
  running = false,
}: {
  runtime: SharedWorkspaceRuntimeApi
  running?: boolean
}) {
  const [open, setOpen] = useState(true)
  const [currentTask, setCurrentTask] = useState('task-1')
  const session = useMemo(
    () => createRuntimeConversationSession(runtime, { ...address, taskId: currentTask }),
    [runtime, currentTask]
  )
  useEffect(() => {
    session.start()
    return session.stop
  }, [session])
  const draft = useBrowserTaskDraft(`device-1:${currentTask}`)
  return (
    <>
      <button
        data-testid="seed"
        onClick={() => {
          draft.setDraft(`Follow up ${currentTask}`)
          draft.setSelection({
            model,
            options: {
              permissionMode: 'full-access',
              collaborationMode: 'plan',
              reasoningEffort: 'high',
            },
          })
        }}
      >
        Seed
      </button>
      <button
        data-testid="attach"
        onClick={() => void draft.attachments.handleFileSelect(new File(['data'], 'context.bin'))}
      >
        Attach
      </button>
      <button data-testid="toggle" onClick={() => setOpen(value => !value)}>
        Toggle
      </button>
      <button
        data-testid="switch"
        onClick={() => setCurrentTask(value => (value === 'task-1' ? 'task-2' : 'task-1'))}
      >
        Switch
      </button>
      {open && (
        <BrowserTaskComposer
          key={currentTask}
          runtime={runtime}
          session={session}
          address={{ ...address, taskId: currentTask }}
          task={{ ...task, taskId: currentTask }}
          projectId="project-1"
          running={running}
          imageServices={{ identity: file => String(file.id), load: vi.fn(), download: vi.fn() }}
          translate={translate}
          onAccepted={async () => {}}
        />
      )}
    </>
  )
}

describe('browser adapter for the PC task composer', () => {
  let root: Root
  let container: HTMLDivElement
  let runtime: SharedWorkspaceRuntimeApi
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    // jsdom has no text-range geometry; ProseMirror reads it after selection changes.
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [],
    })
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect(),
    })
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }))
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    )
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    runtime = {
      executeCommand: vi.fn(),
      fileChangesFromError: () => undefined,
      listDevices: vi.fn().mockResolvedValue([]),
      subscribeChatStream: vi.fn().mockResolvedValue(() => {}),
      work: {
        createRuntimeTask: vi.fn(),
        listRuntimeWork: vi.fn(),
        sendRuntimeMessage: vi.fn().mockResolvedValue({ accepted: true }),
        guideRuntimeTask: vi.fn().mockResolvedValue({ accepted: true }),
        interruptAndSendRuntimeMessage: vi.fn().mockResolvedValue({ accepted: true }),
        cancelRuntimeTask: vi.fn(),
        revertRuntimeFileChanges: vi.fn(),
        getRuntimeGoal: vi.fn().mockResolvedValue({ accepted: true, taskId: 'task-1', goal: null }),
      },
      listModels: vi.fn().mockResolvedValue([model]),
      uploadAttachment: vi.fn().mockResolvedValue(attachment),
      deleteAttachment: vi.fn(),
      readAttachment: vi.fn(),
      readWorkspaceFile: vi.fn(),
      openModelSettings: vi.fn(),
      getTranscript: vi.fn().mockResolvedValue({
        runtime: 'codex',
        workspacePath: '/actual/workspace',
        running: false,
        messages: [],
        turns: [],
      }),
      subscribe: vi.fn().mockResolvedValue(() => {}),
      cancel: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    }
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })
  const element = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
  async function click(id: string) {
    await act(async () => element(id).click())
  }
  async function mount(running = false) {
    await act(async () =>
      root.render(
        <BrowserTaskDrafts runtime={runtime}>
          <Harness runtime={runtime} running={running} />
        </BrowserTaskDrafts>
      )
    )
  }

  it('displays the addressed task usage and sends its confirmed compact command', async () => {
    const breakdown = {
      totalTokens: 700,
      inputTokens: 700,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    }
    vi.mocked(runtime.getTranscript).mockResolvedValueOnce({
      runtime: 'codex',
      workspacePath: '/actual/workspace',
      running: false,
      messages: [],
      turns: [],
      contextUsage: { last: breakdown, total: breakdown, modelContextWindow: 1000 },
    })
    await mount()
    expect(element('context-usage-indicator').getAttribute('aria-label')).toContain('70%')
    await click('context-usage-button')
    expect(element('compact-context-confirm-popover').textContent).toContain('压缩')
    expect(runtime.work.sendRuntimeMessage).not.toHaveBeenCalled()
    await click('confirm-compact-context-button')
    expect(runtime.work.sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        address: expect.objectContaining(address),
        message: '/compact',
      })
    )
    await click('switch')
    expect(element('context-usage-indicator')).toBeNull()
  })

  it('inserts a PC quick phrase into the live draft and sends its selected mode', async () => {
    runtime.quickPhrases = createQuickPhrasePreferencesStore({
      load: async () => defaultQuickPhrases,
      save: vi.fn(),
    })
    await mount()
    await click('seed')
    await click('quick-phrase-button')
    await click('quick-phrase-option-default-summary-progress')
    expect(element('chat-input').textContent).toContain('Follow up task-1')
    expect(element('chat-input').textContent).toContain(defaultQuickPhrases[0].content)
    await click('send-message-button')
    expect(runtime.work.sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: `Follow up task-1\n${defaultQuickPhrases[0].content}`,
        modelOptions: expect.objectContaining({ collaborationMode: 'default' }),
      })
    )
  })

  it('preserves edited preferences after a failed save and uses them after successful retry', async () => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value() {
        this.open = true
      },
    })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value() {
        this.open = false
      },
    })
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('Cannot save'))
      .mockImplementation(async next => next)
    runtime.quickPhrases = createQuickPhrasePreferencesStore({ load: async () => [], save })
    await mount()
    await click('quick-phrase-button')
    await click('manage-quick-phrases-button')
    await click('add-quick-phrase-button')
    async function fill(id: string, value: string) {
      const target = element(id) as HTMLInputElement | HTMLTextAreaElement
      const prototype =
        target instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype
      await act(async () => {
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(target, value)
        target.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await fill('quick-phrase-title-input', 'Review')
    await fill('quick-phrase-content-input', 'Review this implementation')
    await click('quick-phrase-mode-plan')
    await click('quick-phrase-save-button')
    expect(document.body.textContent).toContain('Cannot save')
    expect((element('quick-phrase-content-input') as HTMLTextAreaElement).value).toBe(
      'Review this implementation'
    )
    expect(runtime.quickPhrases.getSnapshot().phrases).toEqual([])
    await click('quick-phrase-save-button')
    expect(element('quick-phrase-content-input')).toBeNull()
    await click('add-quick-phrase-button')
    await act(async () =>
      element('quick-phrase-title-input').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    )
    expect(element('quick-phrase-content-input')).toBeNull()
    expect(element('quick-phrase-preferences-dialog')).not.toBeNull()
    await click('quick-phrase-preferences-close')
    await click('quick-phrase-button')
    const phrase = runtime.quickPhrases.getSnapshot().phrases[0]
    await click(`quick-phrase-option-${phrase.id}`)
    await click('send-message-button')
    expect(runtime.work.sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Review this implementation',
        modelOptions: expect.objectContaining({ collaborationMode: 'plan' }),
      })
    )
  })

  it.each([440, 800])(
    'keeps the PC side-conversation menu order and icon-only picker at width %i',
    async width => {
      const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        width,
        height: 32,
        top: 0,
        bottom: 32,
        left: 0,
        right: width,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      })
      runtime.quickPhrases = createQuickPhrasePreferencesStore({
        load: async () => [],
        save: async items => items,
      })
      runtime.composer = { readCatalog: vi.fn(), searchWorkspaceEntries: vi.fn() }
      try {
        await mount()
        const quick = element('quick-phrase-button')
        const plugin = element('composer-plugin-picker-button')
        expect(
          quick.compareDocumentPosition(plugin) & Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy()
        expect(element('composer-toolbar').getAttribute('data-compact')).toBe(String(width < 475))
        expect(plugin.classList.contains('w-7')).toBe(true)
        expect(element('composer-plugin-preview-icons')).toBeNull()
      } finally {
        bounds.mockRestore()
      }
    }
  )

  it('uses the shared skill menu and sends its reference to the bound runtime task', async () => {
    const readCatalog = vi.fn().mockResolvedValue({
      ...emptyPluginSnapshot,
      skills: [
        {
          name: 'pdf',
          path: '/skills/pdf/SKILL.md',
          description: 'Read documents',
          source: 'codex',
        },
      ],
    })
    runtime.composer = {
      readCatalog,
      searchWorkspaceEntries: vi.fn().mockResolvedValue({ files: [] }),
    }
    await mount()
    const editor = element('chat-input') as HTMLElement & { value: string }
    await act(async () => {
      editor.value = '$pdf'
      editor.focus()
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'f', bubbles: true }))
    })
    expect(readCatalog).toHaveBeenCalledWith({ deviceId: 'device-1', taskId: 'task-1' }, true)
    expect(element('local-skill-option-pdf')).not.toBeNull()
    await click('local-skill-option-pdf')
    expect(editor.value).toBe('[$pdf](/skills/pdf/SKILL.md) ')
    await click('send-message-button')
    expect(runtime.work.sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        address: expect.objectContaining(address),
        message: '[$pdf](/skills/pdf/SKILL.md)',
      })
    )
  })

  it('selects a plugin through the PC menu without replacing the live draft and sends to the bound task', async () => {
    const readCatalog = vi.fn().mockResolvedValue({
      ...emptyPluginSnapshot,
      skills: [],
      marketplaces: [
        {
          name: 'local-tools',
          plugins: [
            {
              id: 'pdf',
              name: 'pdf',
              installed: true,
              enabled: true,
              interface: { displayName: 'PDF', defaultPrompt: ['Review this document'] },
            },
          ],
        },
      ],
    })
    runtime.composer = { readCatalog, searchWorkspaceEntries: vi.fn() }
    await mount()
    const editor = element('chat-input') as HTMLElement & { value: string }
    await act(async () => {
      editor.value = 'Review'
      editor.focus()
    })
    await click('composer-plugin-picker-button')
    expect(readCatalog).toHaveBeenCalledWith(address, true)
    await click('composer-plugin-picker-item-plugin:pdf')
    expect(editor.value).toContain('Review')
    expect(editor.value).toContain('plugin://')
    expect(document.activeElement).toBe(editor)
    expect(element('plugin-trial-template-strip')).not.toBeNull()
    await click('switch')
    expect(element('plugin-trial-template-strip')).toBeNull()
    await click('switch')
    expect(element('plugin-trial-template-strip')).not.toBeNull()
    await click('plugin-trial-recommendation-apply')
    const activeEditor = element('chat-input') as HTMLElement & { value: string }
    expect(activeEditor.value).toBe('[$PDF](plugin://pdf@local-tools) Review this document ')
    expect(document.activeElement).toBe(activeEditor)
    expect(runtime.work.sendRuntimeMessage).not.toHaveBeenCalled()
    await click('send-message-button')
    expect(runtime.work.sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        address: expect.objectContaining(address),
        message: expect.stringContaining('plugin://'),
      })
    )
    expect(element('plugin-trial-template-strip')).toBeNull()
  })

  it('ignores a catalog response after switching the bound task', async () => {
    let finishOld!: (snapshot: unknown) => void
    const readCatalog = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishOld = resolve
          })
      )
      .mockResolvedValueOnce({
        ...emptyPluginSnapshot,
        taskId: 'task-2',
        skills: [
          {
            name: 'new-skill',
            path: '/task-2/SKILL.md',
            description: 'New task skill',
            source: 'codex',
          },
        ],
      })
    runtime.composer = { readCatalog, searchWorkspaceEntries: vi.fn() }
    await mount()
    const openSkills = async () => {
      const editor = element('chat-input') as HTMLElement & { value: string }
      await act(async () => {
        editor.value = '$'
        editor.focus()
        editor.dispatchEvent(new KeyboardEvent('keyup', { key: '$', bubbles: true }))
      })
    }
    await openSkills()
    await click('switch')
    await openSkills()
    expect(readCatalog).toHaveBeenLastCalledWith({ deviceId: 'device-1', taskId: 'task-2' }, true)
    await act(async () =>
      finishOld({
        ...emptyPluginSnapshot,
        skills: [{ name: 'old-skill', path: '/task-1/SKILL.md', source: 'codex' }],
      })
    )
    expect(element('local-skill-option-new-skill')).not.toBeNull()
    expect(element('local-skill-option-old-skill')).toBeNull()
  })

  it('preserves the task draft, chosen settings and attachments after rejection and sends the authoritative address', async () => {
    vi.mocked(runtime.work.sendRuntimeMessage).mockResolvedValueOnce({
      accepted: false,
      taskId: 'task-1',
      error: 'Device offline',
    })
    await mount()
    await click('seed')
    await click('attach')
    await click('send-message-button')
    expect(container.textContent).toContain('Device offline')
    expect(element('chat-input').textContent).toContain('Follow up task-1')
    expect(element('attachment-badge')).toBeTruthy()
    expect(runtime.work.sendRuntimeMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        address: expect.objectContaining({
          ...address,
          workspacePath: '/actual/workspace',
          runtime: 'codex',
        }),
        message: 'Follow up task-1',
        modelId: model.name,
        modelType: 'runtime',
        cloudProjectId: 'project-1',
        attachmentIds: [17],
        modelOptions: {
          permissionMode: 'full-access',
          collaborationMode: 'plan',
          reasoningEffort: 'high',
        },
        collaborationMode: 'plan',
        modelSelection: {
          modelName: model.name,
          modelType: 'runtime',
          options: {
            permissionMode: 'full-access',
            collaborationMode: 'plan',
            reasoningEffort: 'high',
          },
        },
      })
    )
    await click('send-message-button')
    expect(element('chat-input').textContent).not.toContain('Follow up task-1')
    expect(container.querySelector('[data-testid="attachment-badge"]')).toBeNull()
  })

  it('keeps unsent text and files scoped to the task through closing and switching drawers', async () => {
    await mount()
    await click('seed')
    await click('attach')
    await click('toggle')
    await click('toggle')
    expect(element('chat-input').textContent).toContain('Follow up task-1')
    expect(element('attachment-badge')).toBeTruthy()
    await click('switch')
    expect(element('chat-input').textContent).not.toContain('Follow up task-1')
    expect(container.querySelector('[data-testid="attachment-badge"]')).toBeNull()
    await click('seed')
    await click('switch')
    expect(element('chat-input').textContent).toContain('Follow up task-1')
    expect(element('attachment-badge')).toBeTruthy()
  })

  it('keeps an in-flight send locked when the drawer is closed and reopened', async () => {
    let finish!: (value: { accepted: boolean; taskId: string }) => void
    vi.mocked(runtime.work.sendRuntimeMessage).mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve
      })
    )
    await mount()
    await click('seed')
    await click('send-message-button')
    await click('toggle')
    await click('toggle')
    expect(element('send-message-button').getAttribute('disabled')).not.toBeNull()
    await click('send-message-button')
    expect(runtime.work.sendRuntimeMessage).toHaveBeenCalledTimes(1)
    await act(async () => finish({ accepted: true, taskId: 'task-1' }))
    expect(element('chat-input').textContent).not.toContain('Follow up task-1')
  })

  it.each([
    ['guide-current-turn-option', 'guideRuntimeTask'],
    ['interrupt-and-send-option', 'interruptAndSendRuntimeMessage'],
  ] as const)('routes %s to its real runtime operation', async (option, method) => {
    await mount(true)
    await click('seed')
    await click('send-mode-menu-button')
    await click(option)
    expect(runtime.work[method]).toHaveBeenCalledTimes(1)
    expect(runtime.work[method]).toHaveBeenCalledWith(
      expect.objectContaining({
        address: expect.objectContaining(address),
        message: 'Follow up task-1',
      })
    )
    for (const other of [
      'sendRuntimeMessage',
      'guideRuntimeTask',
      'interruptAndSendRuntimeMessage',
    ] as const) {
      if (other !== method) expect(runtime.work[other]).not.toHaveBeenCalled()
    }
  })

  it('keeps rejected guidance editable in the shared queue despite a success flag', async () => {
    vi.mocked(runtime.work.guideRuntimeTask).mockResolvedValue({
      accepted: false,
      success: true,
      error: 'Guidance rejected',
    })
    await mount(true)
    await click('seed')
    await click('send-mode-menu-button')
    await click('guide-current-turn-option')
    expect(container.textContent).toContain('Guidance rejected')
    expect(element('chat-input').textContent).not.toContain('Follow up task-1')
    expect(element('conversation-queue-panel').textContent).toContain('Follow up task-1')
  })

  it('reports rejected stop requests without clearing the draft', async () => {
    vi.mocked(runtime.cancel).mockRejectedValue(new Error('Stop rejected'))
    await mount(true)
    await click('pause-response-button')
    expect(container.textContent).toContain('Stop rejected')
    expect(runtime.cancel).toHaveBeenCalledWith(address)
  })
  it('shows the PC queue while busy and sends it once when the conversation becomes idle', async () => {
    await mount(true)
    await click('seed')
    await click('attach')
    await click('send-mode-menu-button')
    await click('send-after-turn-option')
    expect(runtime.work.sendRuntimeMessage).not.toHaveBeenCalled()
    expect(element('conversation-queue-panel').textContent).toContain('Follow up task-1')
    expect(element('chat-input').textContent).not.toContain('Follow up task-1')
    await click('toggle')
    await click('toggle')
    expect(element('conversation-queue-panel').textContent).toContain('Follow up task-1')
    await mount(false)
    expect(runtime.work.sendRuntimeMessage).toHaveBeenCalledTimes(1)
    expect(runtime.work.sendRuntimeMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        attachmentIds: [17],
        modelId: model.name,
        modelOptions: expect.objectContaining({ reasoningEffort: 'high' }),
      })
    )
    expect(container.querySelector('[data-testid="conversation-queue-panel"]')).toBeNull()
  })
  it('edits or deletes a queued reply using the PC queue controls', async () => {
    await mount(true)
    await click('seed')
    await click('attach')
    await click('send-message-button')
    const row = container.querySelector<HTMLElement>('[data-testid^="conversation-queue-row-"]')!
    const id = row.dataset.testid!.replace('conversation-queue-row-', '')
    await click('queue-more-button-' + id)
    await click('queue-edit-button-' + id)
    expect(element('chat-input').textContent).toContain('Follow up task-1')
    expect(element('attachment-badge')).toBeTruthy()
    expect(container.querySelector('[data-testid="conversation-queue-panel"]')).toBeNull()
    await click('send-message-button')
    const next = container.querySelector<HTMLElement>('[data-testid^="queue-cancel-button-"]')!
    await act(async () => next.click())
    expect(container.querySelector('[data-testid="conversation-queue-panel"]')).toBeNull()
    expect(runtime.work.sendRuntimeMessage).not.toHaveBeenCalled()
  })

  it('keeps guidance pending through reopening and removes it only on the runtime applied event', async () => {
    await mount(true)
    await click('seed')
    await click('send-mode-menu-button')
    await click('guide-current-turn-option')
    const row = container.querySelector<HTMLElement>('[data-testid^="conversation-queue-row-"]')!
    const id = row.dataset.testid!.replace('conversation-queue-row-', '')
    expect(row.textContent).toContain('引导中')
    await click('toggle')
    await click('toggle')
    expect(element('conversation-queue-panel').textContent).toContain('引导中')
    expect(runtime.work.guideRuntimeTask).toHaveBeenCalledTimes(1)
    const handlers = vi.mocked(runtime.subscribe).mock.calls.at(-1)![1]
    await act(async () =>
      handlers.onGuidanceApplied?.({
        deviceId: address.deviceId,
        taskId: address.taskId,
        guidanceId: 'server-guidance',
        clientGuidanceId: id,
        message: 'Follow up task-1',
        appliedAtMs: 1,
      })
    )
    expect(container.querySelector('[data-testid="conversation-queue-panel"]')).toBeNull()
  })
  it('queues an explicit busy transport rejection without resubmitting against unchanged state', async () => {
    vi.mocked(runtime.work.sendRuntimeMessage).mockRejectedValueOnce(
      new Error('Runtime task is already running')
    )
    await mount()
    await click('seed')
    await click('attach')
    await click('send-message-button')
    expect(element('conversation-queue-panel').textContent).toContain('Follow up task-1')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(element('chat-input').textContent).not.toContain('Follow up task-1')
    await click('toggle')
    await click('toggle')
    expect(runtime.work.sendRuntimeMessage).toHaveBeenCalledTimes(1)
  })
})
