import type { CloudProject } from '@/api/deliveries'
import { notifyLocalPluginSkillsChanged } from '@/features/plugins/pluginTrial'
import { SELECTED_TEXT_DRAG_TYPE } from '@/lib/selected-text-drag'
import { WORKBENCH_NEW_CHAT_FOCUS_EVENT } from '@/lib/workbenchComposerFocus'
import type { LocalDeviceApp, LocalDeviceSkill } from '@/types/api'
import type { WorkspaceTarget } from '@/types/workspace-files'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { getComposerDiagnosticsSnapshot } from '@wegent/collaboration/composer/composerDiagnostics'
import { createComposerCatalogStore } from '@wegent/collaboration/composer/createComposerCatalogStore'
import { createRef, useState } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { clearComposerAppsSnapshot, resetComposerAppsMemory } from './composerAppsSnapshot'
import { ComposerCatalogContext } from './ComposerCatalogContext'
import type {
  ComposerCloudMentionCandidate,
  ComposerConversationMentionCandidate,
} from './composerMentionCandidates'
import { ComposerTextarea, type ComposerTextareaHandle } from './ComposerTextarea'
import { PluginPickerMenu } from './PluginPickerMenu'

const nativeWorkspacePickerMocks = vi.hoisted(() => ({
  open: vi.fn(),
}))

const nativeClipboardPathMocks = vi.hoisted(() => ({
  resolve: vi.fn(),
}))

vi.mock('@/lib/native-workspace-path-picker', () => ({
  canOpenNativeWorkspacePathPicker: () => true,
  openNativeWorkspacePathPicker: nativeWorkspacePickerMocks.open,
}))

vi.mock('@/lib/workspace-path-transfer', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/workspace-path-transfer')>()),
  resolveDataTransferWorkspacePaths: nativeClipboardPathMocks.resolve,
}))

const GMAIL_SKILL: LocalDeviceSkill = {
  name: 'gmail',
  description: 'Manage Gmail',
  path: '/tmp/gmail/SKILL.md',
  source: 'codex',
}
const GMAIL_REFERENCE = '[$gmail](/tmp/gmail/SKILL.md)'

const GITHUB_PLUGIN: LocalDeviceApp = {
  id: 'github',
  name: 'GitHub',
  description: '检查仓库、处理拉取请求和 Issue，并通过 GitHub 工作流发布代码变更。',
  logoUrl: 'https://example.com/github.png',
  isAccessible: true,
  isEnabled: true,
  pluginDisplayNames: ['Wegent Cloud'],
  source: 'wegent-connector',
  skillPath: '/tmp/github/SKILL.md',
}

const WEBSITE_PROJECT: CloudProject = {
  id: '7',
  public_id: 'pub-7',
  project_key: 'GW',
  name: '官网改版',
  description: '官网改版协作空间',
  created_by_user_id: 1,
  status: 'active',
  version: 1,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
}
const MOBILE_PROJECT: CloudProject = {
  ...WEBSITE_PROJECT,
  id: '9',
  public_id: 'pub-9',
  project_key: 'MB',
  name: '移动端重构',
  description: '',
}

function installDshExtensionHost() {
  const execute = vi.fn().mockResolvedValue(undefined)
  const listeners = new Set<() => void>()
  window.__WEWORK_DSH_EXTENSIONS__ = {
    getRevision: () => 1,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    commands: {
      execute,
      get: id =>
        id === 'quality.run'
          ? {
              description: 'Run the contributed quality check',
              id,
              title: 'Run quality check',
            }
          : null,
      list: () => [],
      register: vi.fn(),
      subscribe: () => () => {},
    },
    composer: {
      references: {
        list: () => [
          {
            enabled: true,
            id: 'quality.report',
            metaLabel: 'Quality',
            reference: '[$Quality](quality://report)',
            searchAliases: ['report'],
            title: 'Quality report',
          },
        ],
        register: vi.fn(),
        subscribe: () => () => {},
      },
    },
    configuration: {
      get: () => null,
      getDefinition: () => null,
      register: vi.fn(),
      subscribe: () => () => {},
      update: vi.fn(),
    },
    context: {
      entries: () => ({}),
      get: () => undefined,
      matches: () => true,
      set: vi.fn(),
      subscribe: () => () => {},
    },
    keybindings: {
      list: () => [],
      register: vi.fn(),
      subscribe: () => () => {},
    },
    menus: {
      list: location =>
        location === 'composer.slash'
          ? [
              {
                command: 'quality.run',
                enabled: true,
                id: 'quality.run.slash',
              },
            ]
          : [],
      register: vi.fn(),
      subscribe: () => () => {},
    },
    secrets: {
      scope: vi.fn(),
    },
    storage: {
      scope: vi.fn(),
    },
  }
  return { execute }
}

function cloudProjectCandidate(project: CloudProject): ComposerCloudMentionCandidate {
  return {
    kind: 'cloud',
    key: `cloud-project-space:${project.id}`,
    title: project.name,
    description: project.description || project.project_key,
    metaLabel: '云空间',
    testId: `cloud-project-space-${project.id}`,
    enabled: true,
    reference: `[$项目空间:${project.name}](cloud://projects/${project.id})`,
    searchAliases: [project.name, project.project_key, '项目空间', 'project space'],
    project,
  }
}

describe('ComposerTextarea', () => {
  beforeEach(() => {
    nativeWorkspacePickerMocks.open.mockReset()
    nativeWorkspacePickerMocks.open.mockResolvedValue([])
    nativeClipboardPathMocks.resolve.mockReset()
    nativeClipboardPathMocks.resolve.mockResolvedValue({
      attachmentFiles: [],
      referenceEntries: [],
    })
    resetComposerAppsMemory()
    clearComposerAppsSnapshot()
    delete window.__WEWORK_DSH_EXTENSIONS__
  })

  test('allows slash selection of an installed GitHub package pending authorization', async () => {
    const textareaRef = createRef<HTMLElement>()
    const github = {
      ...GITHUB_PLUGIN,
      id: 'plugin:github',
      source: 'installed-plugin',
      isAccessible: false,
      skillPath: 'plugin://github@openai-curated-remote',
    }
    function Harness() {
      const [value, setValue] = useState('')
      return (
        <ComposerTextarea
          value={value}
          onChange={setValue}
          placeholder="Message"
          rows={2}
          textareaRef={textareaRef}
          onListLocalApps={async () => [github]}
        />
      )
    }
    render(<Harness />)
    const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      // Match real input order: native jsdom focus resets the DOM selection.
      editor.focus()
      editor.value = '/github'
    })
    const option = await screen.findByTestId('slash-command-option-app-plugin-github')
    expect(option).toBeEnabled()
    expect(option).toHaveTextContent('待授权')
    fireEvent.click(option)
    await waitFor(() =>
      expect(editor.value).toBe('[$GitHub](plugin://github@openai-curated-remote) ')
    )
    expect(github.isAccessible).toBe(false)
  })

  test('inserts a picker reference only into its own editor when two drawers are mounted', async () => {
    const left = createRef<ComposerTextareaHandle>()
    const right = createRef<ComposerTextareaHandle>()
    const apps = async () => [{ id: 'github', name: 'GitHub', isEnabled: true, isAccessible: true }]
    function Harness({ name, handle }: { name: string; handle: typeof left }) {
      const [value, setValue] = useState(name)
      return (
        <>
          <ComposerTextarea
            ref={handle}
            value={value}
            onChange={setValue}
            onSubmit={vi.fn()}
            canSend
            placeholder="Message"
            rows={2}
            textareaRef={createRef()}
            className="min-h-12"
            testId={name}
          />
          <PluginPickerMenu
            onListLocalApps={apps}
            onInsertReference={reference => {
              handle.current?.insertReference(reference)
              handle.current?.focus()
            }}
          />
        </>
      )
    }
    render(
      <>
        <Harness name="left-draft" handle={left} />
        <Harness name="right-draft" handle={right} />
      </>
    )
    act(() => right.current?.setValue('right-draft', 5))
    fireEvent.click(screen.getAllByTestId('composer-plugin-picker-button')[1])
    fireEvent.click(await screen.findByTestId('composer-plugin-picker-item-github'))
    expect(left.current?.getValue()).toBe('left-draft')
    expect(right.current?.getValue()).toContain('[$GitHub]')
    expect(right.current?.getValue()).toContain('-draft')
    expect(document.activeElement).toBe(screen.getByTestId('right-draft'))
  })

  test('places the caret at the end when returning to a restored new-chat draft', async () => {
    const textareaRef = createRef<HTMLElement>()
    const value = 'restored draft'

    render(
      <ComposerTextarea
        value={value}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        canSend
        placeholder="Message"
        rows={2}
        textareaRef={textareaRef}
        className="min-h-12"
      />
    )

    const editor = screen.getByTestId('chat-message-input')
    const textNode = editor.querySelector('p')?.firstChild
    expect(textNode).not.toBeNull()
    act(() => {
      const range = document.createRange()
      range.setStart(textNode!, 0)
      range.collapse(true)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
      window.dispatchEvent(new Event(WORKBENCH_NEW_CHAT_FOCUS_EVENT))
    })

    await waitFor(() => {
      expect(editor).toHaveFocus()
      expect(window.getSelection()?.anchorOffset).toBe(value.length)
    })
  })

  test('uses the interrupt send mode for Command-Shift-Enter', () => {
    const textareaRef = createRef<HTMLElement>()
    const onSubmit = vi.fn()

    render(
      <ComposerTextarea
        value="Stop and do this now"
        onChange={vi.fn()}
        onSubmit={onSubmit}
        canSend
        placeholder="Message"
        rows={2}
        textareaRef={textareaRef}
        className="min-h-12"
      />
    )

    const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      editor.value = 'Stop and do this now'
      editor.focus()
    })
    fireEvent.keyDown(editor, {
      key: 'Enter',
      code: 'Enter',
      metaKey: true,
      shiftKey: true,
    })

    expect(onSubmit).toHaveBeenCalledWith('Stop and do this now', {
      interruptWhenBusy: true,
    })
  })

  test('uses Command-Enter to send when configured and keeps Enter as a line break', () => {
    const textareaRef = createRef<HTMLElement>()
    const composerRef = createRef<ComposerTextareaHandle>()
    const onChange = vi.fn()
    const onSubmit = vi.fn()

    render(
      <ComposerTextarea
        ref={composerRef}
        value="Send this"
        onChange={onChange}
        onSubmit={onSubmit}
        canSend
        placeholder="Message"
        rows={2}
        textareaRef={textareaRef}
        className="min-h-12"
        sendKey="cmd_enter"
      />
    )

    const editor = screen.getByTestId('chat-message-input')
    composerRef.current?.setValue('Send this', 'Send this'.length)
    fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledWith('Send this\n')
    expect(composerRef.current?.getValue()).toBe('Send this\n')

    fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter', metaKey: true })
    expect(onSubmit).toHaveBeenCalledWith('Send this\n', undefined)
  })

  test('applies the configured follow-up behavior while a response is streaming', () => {
    const textareaRef = createRef<HTMLElement>()
    const onSubmit = vi.fn()

    render(
      <ComposerTextarea
        value="Adjust the response"
        onChange={vi.fn()}
        onSubmit={onSubmit}
        canSend
        placeholder="Message"
        rows={2}
        textareaRef={textareaRef}
        className="min-h-12"
        sendKey="cmd_enter"
        followUpBehavior="guide"
        isStreaming
      />
    )

    const editor = screen.getByTestId('chat-message-input')
    fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter', metaKey: true })

    expect(onSubmit).toHaveBeenCalledWith('Adjust the response', {
      guideWhenBusy: true,
    })
  })

  test('does not confirm via Tab during IME composition', async () => {
    const textareaRef = createRef<HTMLElement>()
    const onChange = vi.fn()
    const onSubmit = vi.fn()

    function Harness() {
      const [value, setValue] = useState('')
      return (
        <ComposerTextarea
          value={value}
          onChange={nextValue => {
            onChange(nextValue)
            setValue(nextValue)
          }}
          onSubmit={onSubmit}
          canSend={false}
          placeholder="Message"
          rows={2}
          textareaRef={textareaRef}
          className="min-h-12"
          onOpenSkillFile={vi.fn()}
          onListLocalSkills={async () => [GMAIL_SKILL]}
        />
      )
    }

    render(<Harness />)
    const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }

    act(() => {
      editor.value = '$gmail'
      editor.focus()
    })
    await screen.findByTestId('local-skill-option-gmail')

    expect(
      fireEvent.keyDown(editor, {
        key: 'Tab',
        code: 'Tab',
        keyCode: 229,
        which: 229,
        charCode: 229,
      })
    ).toBe(true)
    expect(editor.value).toBe('$gmail')
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByTestId('local-skill-option-gmail')).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalledWith(`${GMAIL_REFERENCE} `)
  })

  test('consumes the Tab that confirms a slash command from the / menu', async () => {
    const textareaRef = createRef<HTMLElement>()
    const onSetGoal = vi.fn()
    const onSubmit = vi.fn()

    function Harness() {
      const [value, setValue] = useState('')
      return (
        <ComposerTextarea
          value={value}
          onChange={setValue}
          onSubmit={onSubmit}
          canSend={false}
          placeholder="Message"
          rows={2}
          textareaRef={textareaRef}
          className="min-h-12"
          onSetGoal={onSetGoal}
        />
      )
    }

    render(<Harness />)
    const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }

    act(() => {
      editor.value = '/goal'
      editor.focus()
    })
    await screen.findByTestId('slash-command-option-goal')

    fireEvent.keyDown(editor, { key: 'Tab', code: 'Tab', keyCode: 9, charCode: 9 })

    expect(onSetGoal, JSON.stringify(getComposerDiagnosticsSnapshot())).toHaveBeenCalledOnce()
    expect(onSubmit).not.toHaveBeenCalled()
    await waitFor(() => expect(editor.value).toBe(''))
    await waitFor(() => expect(screen.queryByTestId('slash-command-menu')).not.toBeInTheDocument())
  })

  test('executes a contributed command from the slash menu', async () => {
    const textareaRef = createRef<HTMLElement>()
    const { execute } = installDshExtensionHost()

    function Harness() {
      const [value, setValue] = useState('')
      return (
        <ComposerTextarea
          value={value}
          onChange={setValue}
          onSubmit={vi.fn()}
          canSend={false}
          placeholder="Message"
          rows={2}
          textareaRef={textareaRef}
          className="min-h-12"
        />
      )
    }

    render(<Harness />)
    const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }

    act(() => {
      editor.value = '/quality'
      editor.focus()
    })
    fireEvent.click(await screen.findByTestId('slash-command-option-dsh-command-quality.run.slash'))

    await waitFor(() => expect(execute).toHaveBeenCalled())
    const invocation = execute.mock.calls[0]?.[2]
    expect(invocation).toMatchObject({
      menuId: 'quality.run.slash',
      menuLocation: 'composer.slash',
      source: 'slash',
    })
    expect(invocation.composer.getValue()).toBe('')
    act(() => invocation.composer.insertText('Review this change:\n'))
    expect(editor.value).toBe('Review this change:\n')
  })

  test('inserts a contributed reference from the mention menu', async () => {
    const textareaRef = createRef<HTMLElement>()
    installDshExtensionHost()

    function Harness() {
      const [value, setValue] = useState('')
      return (
        <ComposerTextarea
          value={value}
          onChange={setValue}
          onSubmit={vi.fn()}
          canSend={false}
          placeholder="Message"
          rows={2}
          textareaRef={textareaRef}
          className="min-h-12"
        />
      )
    }

    render(<Harness />)
    const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }

    act(() => {
      editor.value = '@quality'
      editor.focus()
    })
    fireEvent.click(await screen.findByTestId('extension-reference-option-quality.report'))

    await waitFor(() => expect(editor.value).toBe('[$Quality](quality://report) '))
  })

  test('consumes the Tab that confirms the highlighted @ mention', async () => {
    const textareaRef = createRef<HTMLElement>()
    const searchWorkspaceEntries = vi.fn().mockResolvedValue({
      files: [
        {
          root: '/workspace/project',
          path: 'src/auth.ts',
          fileName: 'auth.ts',
          matchType: 'file',
          score: 100,
          indices: [4, 5, 6, 7],
        },
      ],
    })
    const workspaceTarget: WorkspaceTarget = {
      deviceId: 'local-device',
      path: '/workspace/project',
      source: 'project',
    }

    function Harness() {
      const [value, setValue] = useState('')
      return (
        <ComposerTextarea
          value={value}
          onChange={setValue}
          onSubmit={vi.fn()}
          canSend={false}
          placeholder="Message"
          rows={2}
          textareaRef={textareaRef}
          className="min-h-12"
          workspaceTarget={workspaceTarget}
          workspaceFileApi={{
            listWorkspaceEntries: vi.fn(),
            searchWorkspaceEntries,
            readWorkspaceTextFile: vi.fn(),
          }}
        />
      )
    }

    render(<Harness />)
    const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      editor.value = '@auth'
      editor.focus()
    })

    await screen.findByTestId('workspace-mention-option-0')
    fireEvent.keyDown(editor, { key: 'Tab', code: 'Tab', keyCode: 9, charCode: 9 })
    await waitFor(() => {
      expect(editor.value).toContain('[$auth.ts](file://')
      expect(screen.getByTestId('composer-path-chip-auth-ts')).toHaveAttribute(
        'data-composer-path',
        '/workspace/project/src/auth.ts'
      )
      expect(screen.getByTestId('composer-path-chip-auth-ts')).toHaveTextContent('auth.ts')
    })
  })

  test('does not intercept Tab when no autocomplete menu is open', () => {
    const textareaRef = createRef<HTMLElement>()
    render(
      <ComposerTextarea
        value="plain text"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        canSend
        placeholder="Message"
        rows={2}
        textareaRef={textareaRef}
        className="min-h-12"
      />
    )

    const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      editor.value = 'plain text'
      editor.focus()
    })

    expect(fireEvent.keyDown(editor, { key: 'Tab', code: 'Tab', keyCode: 9, charCode: 9 })).toBe(
      true
    )
  })

  test('does not confirm via Tab when the menu has no selectable option', async () => {
    const textareaRef = createRef<HTMLElement>()
    const onChange = vi.fn()

    function Harness() {
      const [value, setValue] = useState('')
      return (
        <ComposerTextarea
          value={value}
          onChange={nextValue => {
            onChange(nextValue)
            setValue(nextValue)
          }}
          onSubmit={vi.fn()}
          canSend={false}
          placeholder="Message"
          rows={2}
          textareaRef={textareaRef}
          className="min-h-12"
        />
      )
    }

    render(<Harness />)
    const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      editor.value = '/unknown-command'
      editor.focus()
    })

    await screen.findByTestId('slash-command-menu')

    expect(fireEvent.keyDown(editor, { key: 'Tab', code: 'Tab', keyCode: 9, charCode: 9 })).toBe(
      true
    )
    expect(editor.value).toBe('/unknown-command')
  })

  test('uses the same task-scoped source for slash plugins and skills', async () => {
    const listApps = vi.fn().mockResolvedValue([GITHUB_PLUGIN])
    const listSkills = vi.fn().mockResolvedValue([GMAIL_SKILL])
    const inheritedApps = vi.fn()
    const inheritedSkills = vi.fn()
    render(
      <ComposerCatalogContext.Provider
        value={{
          appsStore: createComposerCatalogStore(),
          catalogEvents: {},
          listApps,
          listSkills,
        }}
      >
        <ComposerTextarea
          value=""
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          canSend={false}
          placeholder="Message"
          rows={2}
          textareaRef={createRef()}
          className="min-h-12"
          onListLocalApps={inheritedApps}
          onListLocalSkills={inheritedSkills}
        />
      </ComposerCatalogContext.Provider>
    )
    const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      editor.value = '/'
      editor.focus()
    })
    expect(await screen.findByTestId('slash-command-option-app-github')).toBeInTheDocument()
    expect(await screen.findByTestId('slash-command-option-skill-gmail')).toBeInTheDocument()
    expect(listApps).toHaveBeenCalledTimes(1)
    expect(listSkills).toHaveBeenCalledTimes(1)
    expect(inheritedApps).not.toHaveBeenCalled()
    expect(inheritedSkills).not.toHaveBeenCalled()
  })

  test('reloads plugin metadata after the installed plugin state changes', async () => {
    const textareaRef = createRef<HTMLElement>()
    const rawGithubApp: LocalDeviceApp = {
      ...GITHUB_PLUGIN,
      description: 'GitHub repositories, issues, pull requests, and Actions',
      logoUrl: null,
    }
    const onListLocalApps = vi
      .fn<() => Promise<LocalDeviceApp[]>>()
      .mockResolvedValueOnce([rawGithubApp])
      .mockResolvedValueOnce([GITHUB_PLUGIN])

    render(
      <ComposerTextarea
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        canSend={false}
        placeholder="Message"
        rows={2}
        textareaRef={textareaRef}
        className="min-h-12"
        onListLocalApps={onListLocalApps}
      />
    )
    const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      editor.value = '/'
      editor.focus()
    })

    expect(await screen.findByTestId('slash-command-option-app-github')).toHaveTextContent(
      'GitHub repositories, issues, pull requests, and Actions'
    )

    act(() => notifyLocalPluginSkillsChanged())

    await waitFor(() => expect(onListLocalApps).toHaveBeenCalledTimes(2))
    const refreshedOption = await screen.findByTestId('slash-command-option-app-github')
    expect(refreshedOption).toHaveTextContent(
      '检查仓库、处理拉取请求和 Issue，并通过 GitHub 工作流发布代码变更。'
    )
    expect(refreshedOption.querySelector('img')).toHaveAttribute(
      'src',
      'https://example.com/github.png'
    )
  })

  test('inserts an authorized cloud reference from the @ menu', async () => {
    const textareaRef = createRef<HTMLElement>()
    const reference = '[$design.md](cloud://projects/11/files/42)'
    const cloudCandidate: ComposerCloudMentionCandidate = {
      kind: 'cloud',
      key: 'cloud-file:42',
      title: 'design.md',
      description: 'docs/design.md',
      metaLabel: '云空间',
      testId: 'cloud-file-42',
      enabled: true,
      reference,
      searchAliases: ['docs/design.md'],
    }

    function Harness() {
      const [value, setValue] = useState('')
      return (
        <ComposerTextarea
          value={value}
          onChange={setValue}
          onSubmit={vi.fn()}
          canSend={false}
          placeholder="Message"
          rows={2}
          textareaRef={textareaRef}
          className="min-h-12"
          cloudMentionCandidates={[cloudCandidate]}
        />
      )
    }

    render(<Harness />)
    const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      editor.value = '@design'
      editor.focus()
    })

    fireEvent.click(await screen.findByTestId('cloud-reference-option-cloud-file-42'))
    await waitFor(() => expect(editor.value).toBe(`${reference} `))
  })

  test('searches the active workspace for an @ token and inserts the relative path', async () => {
    const textareaRef = createRef<HTMLElement>()
    const searchWorkspaceEntries = vi.fn().mockResolvedValue({
      files: [
        {
          root: '/workspace/project',
          path: 'src/auth.ts',
          fileName: 'auth.ts',
          matchType: 'file',
          score: 100,
          indices: [4, 5, 6, 7],
        },
      ],
    })
    const workspaceTarget: WorkspaceTarget = {
      deviceId: 'local-device',
      path: '/workspace/project',
      source: 'project',
    }

    function Harness() {
      const [value, setValue] = useState('')
      return (
        <ComposerTextarea
          value={value}
          onChange={setValue}
          onSubmit={vi.fn()}
          canSend={false}
          placeholder="Message"
          rows={2}
          textareaRef={textareaRef}
          className="min-h-12"
          workspaceTarget={workspaceTarget}
          workspaceFileApi={{
            listWorkspaceEntries: vi.fn(),
            searchWorkspaceEntries,
            readWorkspaceTextFile: vi.fn(),
          }}
        />
      )
    }

    render(<Harness />)
    const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      editor.value = '@auth'
      editor.focus()
    })

    await screen.findByTestId('workspace-mention-option-0', {}, { timeout: 5_000 })
    expect(searchWorkspaceEntries).toHaveBeenCalledWith(
      'local-device',
      '/workspace/project',
      'auth',
      expect.any(String)
    )
    fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' })
    await waitFor(() => {
      expect(editor.value).toContain('[$auth.ts](file://')
      expect(screen.getByTestId('composer-path-chip-auth-ts')).toHaveAttribute(
        'data-composer-path',
        '/workspace/project/src/auth.ts'
      )
      expect(screen.getByTestId('composer-path-chip-auth-ts')).toHaveTextContent('auth.ts')
    })
  })

  test('shows the complete @ action menu and invokes goal and plan actions', async () => {
    const textareaRef = createRef<HTMLElement>()
    const onSetGoal = vi.fn()
    const onSetPlanMode = vi.fn()

    function Harness() {
      const [value, setValue] = useState('')
      return (
        <ComposerTextarea
          value={value}
          onChange={setValue}
          onSubmit={vi.fn()}
          canSend={false}
          placeholder="Message"
          rows={2}
          textareaRef={textareaRef}
          className="min-h-12"
          onListLocalSkills={async () => [GMAIL_SKILL]}
          onSetGoal={onSetGoal}
          onSetPlanMode={onSetPlanMode}
          onPasteFiles={vi.fn()}
        />
      )
    }

    const view = render(<Harness />)
    let editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      editor.value = '@'
      editor.focus()
    })

    expect(await screen.findByTestId('mention-files-action')).toBeEnabled()
    expect(screen.getByTestId('mention-goal-action')).toBeInTheDocument()
    expect(screen.getByTestId('mention-plan-action')).toBeInTheDocument()
    expect(await screen.findByTestId('local-skill-option-gmail')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('mention-goal-action'))
    expect(onSetGoal).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByTestId('mention-plan-action')).not.toBeInTheDocument())

    // Use a fresh editor for the second independent action. Reopening the same
    // async mention menu can race with the previous menu's dismissal under load.
    view.unmount()
    render(<Harness />)
    editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      editor.value = '@'
      editor.focus()
    })
    fireEvent.click(await screen.findByTestId('mention-plan-action'))
    await waitFor(() => expect(onSetPlanMode).toHaveBeenCalledOnce())
  })

  test('inserts Wework selected text drops at the current composer selection', async () => {
    const textareaRef = createRef<HTMLElement>()

    function Harness() {
      const [value, setValue] = useState('existing draft')
      return (
        <ComposerTextarea
          value={value}
          onChange={setValue}
          onSubmit={vi.fn()}
          canSend={false}
          placeholder="Message"
          rows={2}
          textareaRef={textareaRef}
          className="min-h-12"
        />
      )
    }

    render(<Harness />)
    const editor = screen.getByTestId('chat-message-input')
    const dropEvent = new Event('drop', {
      bubbles: true,
      cancelable: true,
    }) as DragEvent
    Object.defineProperty(dropEvent, 'dataTransfer', {
      value: {
        files: [],
        items: [],
        types: [SELECTED_TEXT_DRAG_TYPE, 'text/plain'],
        getData: (type: string) =>
          type === 'text/plain' ? 'export const selected = true' : 'true',
      },
    })

    fireEvent(editor, dropEvent)

    await waitFor(() => {
      const paragraphs = editor.querySelectorAll('p')
      expect(paragraphs[0]).toHaveTextContent('export const selected = true')
      expect(paragraphs[1]).toHaveTextContent('existing draft')
    })
    expect(dropEvent.defaultPrevented).toBe(true)
  })

  test('does not process selected text drops while disabled', () => {
    const textareaRef = createRef<HTMLElement>()
    const onChange = vi.fn()

    render(
      <ComposerTextarea
        value="keep this draft"
        onChange={onChange}
        onSubmit={vi.fn()}
        canSend={false}
        disabled
        placeholder="Message"
        rows={2}
        textareaRef={textareaRef}
        className="min-h-12"
      />
    )
    const editor = screen.getByTestId('chat-message-input')
    const dropEvent = new Event('drop', {
      bubbles: true,
      cancelable: true,
    }) as DragEvent
    Object.defineProperty(dropEvent, 'dataTransfer', {
      value: {
        files: [],
        items: [],
        types: [SELECTED_TEXT_DRAG_TYPE, 'text/plain'],
        getData: (type: string) => (type === 'text/plain' ? 'ignored text' : 'true'),
      },
    })

    fireEvent(editor, dropEvent)

    expect(dropEvent.defaultPrevented).toBe(true)
    expect(onChange).not.toHaveBeenCalled()
    expect(editor).toHaveTextContent('keep this draft')
  })

  test('drills into cloud project spaces and binds the selected project', async () => {
    const textareaRef = createRef<HTMLElement>()
    const onSelectCloudProject = vi.fn()

    function Harness() {
      const [value, setValue] = useState('')
      return (
        <ComposerTextarea
          value={value}
          onChange={setValue}
          onSubmit={vi.fn()}
          canSend={false}
          placeholder="Message"
          rows={2}
          textareaRef={textareaRef}
          className="min-h-12"
          cloudSpaceEnabled
          cloudProjectCandidates={[
            cloudProjectCandidate(WEBSITE_PROJECT),
            cloudProjectCandidate(MOBILE_PROJECT),
          ]}
          onSelectCloudProject={onSelectCloudProject}
        />
      )
    }

    render(<Harness />)
    const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      editor.value = '@'
      editor.focus()
    })

    fireEvent.click(await screen.findByTestId('mention-cloud-projects-action'))
    expect(await screen.findByTestId('mention-cloud-back-action')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-reference-option-cloud-project-space-7')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-reference-option-cloud-project-space-9')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('cloud-reference-option-cloud-project-space-7'))
    await waitFor(() => expect(editor.value).toBe('[$项目空间:官网改版](cloud://projects/7) '))
    expect(onSelectCloudProject).toHaveBeenCalledWith(WEBSITE_PROJECT)
  })

  test('keeps the direct row in the typed scope when no project matches', async () => {
    const textareaRef = createRef<HTMLElement>()

    function Harness() {
      const [value, setValue] = useState('')
      return (
        <ComposerTextarea
          value={value}
          onChange={setValue}
          onSubmit={vi.fn()}
          canSend={false}
          placeholder="Message"
          rows={2}
          textareaRef={textareaRef}
          className="min-h-12"
          cloudSpaceEnabled
          cloudProjectCandidates={[cloudProjectCandidate(WEBSITE_PROJECT)]}
          onSelectCloudProject={vi.fn()}
        />
      )
    }

    render(<Harness />)
    const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      editor.value = '@项目空间 新建项目'
      editor.focus()
    })

    // The menu stays open across whitespace inside the scope; the phrase
    // matches no project, so only the direct row remains (no create action).
    expect(await screen.findByTestId('mention-cloud-space-direct-action')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-reference-option-cloud-project-space-7')).toBeNull()
    expect(screen.queryByTestId('mention-cloud-create-action')).toBeNull()

    fireEvent.click(screen.getByTestId('mention-cloud-space-direct-action'))
    await waitFor(() => expect(editor.value).toBe('[$项目空间](cloud://projects) '))
  })

  test('inserts another conversation from the at-mention menu', async () => {
    const textareaRef = createRef<HTMLElement>()
    const reference =
      '[$修复登录流程](wework-conversation://%7B%22deviceId%22%3A%22local-device%22%2C%22taskId%22%3A%22source-task%22%7D)'
    const conversationCandidates: ComposerConversationMentionCandidate[] = [
      {
        kind: 'conversation',
        key: 'conversation:local-device:source-task',
        title: '修复登录流程',
        description: 'Wegent',
        metaLabel: '会话',
        testId: 'local-device-source-task',
        enabled: true,
        reference,
        searchAliases: ['修复登录流程', 'Wegent'],
        conversation: {
          key: 'conversation:local-device:source-task',
          title: '修复登录流程',
          address: { deviceId: 'local-device', taskId: 'source-task' },
          reference,
          testId: 'local-device-source-task',
          projectName: 'Wegent',
        },
      },
    ]

    function Harness() {
      const [value, setValue] = useState('')
      return (
        <ComposerTextarea
          value={value}
          onChange={setValue}
          onSubmit={vi.fn()}
          canSend={false}
          placeholder="Message"
          rows={2}
          textareaRef={textareaRef}
          className="min-h-12"
          conversationMentionCandidates={conversationCandidates}
        />
      )
    }

    render(<Harness />)
    const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      editor.value = '@登录'
      editor.focus()
    })

    const option = await screen.findByTestId(
      'conversation-reference-option-local-device-source-task'
    )
    expect(option).toHaveTextContent('修复登录流程')
    fireEvent.click(option)

    await waitFor(() => expect(editor.value).toBe(`${reference} `))
    expect(editor.querySelector('[data-testid^="conversation-chip-"]')).toHaveTextContent(
      '修复登录流程'
    )
  })
})
