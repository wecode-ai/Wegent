import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef, useState } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { CloudProject } from '@/api/deliveries'
import type { LocalDeviceApp, LocalDeviceSkill, UnifiedModel } from '@/types/api'
import type { WorkspaceFileApi, WorkspaceTarget } from '@/types/workspace-files'
import type {
  ComposerCloudMentionCandidate,
  ComposerConversationMentionCandidate,
} from './composerMentionCandidates'
import {
  insertPluginReference,
  notifyLocalPluginSkillsChanged,
} from '@/features/plugins/pluginTrial'
import { WORKBENCH_NEW_CHAT_FOCUS_EVENT } from '@/lib/workbenchComposerFocus'
import { ComposerTextarea } from './ComposerTextarea'

const nativeWorkspacePickerMocks = vi.hoisted(() => ({
  open: vi.fn(),
}))

vi.mock('@/lib/native-workspace-path-picker', () => ({
  canOpenNativeWorkspacePathPicker: () => true,
  openNativeWorkspacePathPicker: nativeWorkspacePickerMocks.open,
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

const TEST_MODEL: UnifiedModel = {
  name: 'gpt-5.6-sol',
  type: 'user',
  displayName: 'GPT-5.6 Sol',
  config: { ui: { family: 'gpt' } },
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
  })

  test('inserts plugin picker references without replacing the current draft', async () => {
    const textareaRef = createRef<HTMLElement>()

    function Harness() {
      const [value, setValue] = useState('keep this draft')
      return (
        <ComposerTextarea
          value={value}
          onChange={setValue}
          onSubmit={vi.fn()}
          canSend
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
      editor.focus()
      insertPluginReference('[$GitHub](/tmp/github/SKILL.md)')
    })

    await waitFor(() => expect(editor.value).toContain('[$GitHub](/tmp/github/SKILL.md)'))
    expect(editor.value).toContain('keep this draft')
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

  test('consumes the Enter that selects a skill without adding a line break', async () => {
    const textareaRef = createRef<HTMLElement>()
    const onChange = vi.fn()
    const onOpenSkillFile = vi.fn()

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
          onOpenSkillFile={onOpenSkillFile}
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
      fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter', keyCode: 13, charCode: 13 })
    ).toBe(false)

    await waitFor(() => expect(editor.value).toBe(`${GMAIL_REFERENCE} `))
    expect(editor.value).not.toContain('\n')
    expect(onChange).toHaveBeenLastCalledWith(`${GMAIL_REFERENCE} `)

    fireEvent.mouseDown(screen.getByTestId('local-skill-chip-gmail'), { button: 0 })
    expect(onOpenSkillFile).toHaveBeenCalledWith('/tmp/gmail/SKILL.md')
  })

  test('places callable plugins between model and skill slash commands', async () => {
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
          onListLocalApps={async () => [GITHUB_PLUGIN]}
          onListLocalSkills={async () => [GMAIL_SKILL]}
          models={[TEST_MODEL]}
          selectedModel={TEST_MODEL}
          onSelectModel={vi.fn()}
        />
      )
    }

    render(<Harness />)
    const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      editor.value = '/'
      editor.focus()
    })

    const modelOption = screen.getByTestId('slash-command-option-model')
    const pluginOption = await screen.findByTestId('slash-command-option-app-github')
    const marketplaceOption = screen.getByTestId('slash-command-option-plugin-marketplace')
    const skillOption = await screen.findByTestId('slash-command-option-skill-gmail')

    expect(modelOption.compareDocumentPosition(pluginOption)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(pluginOption.compareDocumentPosition(marketplaceOption)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(marketplaceOption.compareDocumentPosition(skillOption)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(pluginOption.querySelector('img')).toHaveAttribute(
      'src',
      'https://example.com/github.png'
    )
    expect(pluginOption).toHaveTextContent(
      '检查仓库、处理拉取请求和 Issue，并通过 GitHub 工作流发布代码变更。'
    )
    expect(pluginOption).not.toHaveTextContent('添加')
    expect(pluginOption.querySelectorAll('svg')).toHaveLength(1)

    fireEvent.click(pluginOption)
    await waitFor(() => expect(editor.value).toBe('[$GitHub](/tmp/github/SKILL.md) '))
  })

  test('preloads callable plugins before the slash menu opens', async () => {
    const textareaRef = createRef<HTMLElement>()
    const onListLocalApps = vi.fn().mockResolvedValue([GITHUB_PLUGIN])

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

    await waitFor(() => expect(onListLocalApps).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('slash-command-menu')).not.toBeInTheDocument()

    const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      editor.value = '/'
      editor.focus()
    })

    expect(await screen.findByTestId('slash-command-option-app-github')).toBeInTheDocument()
    expect(onListLocalApps).toHaveBeenCalledTimes(1)
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
    const refreshedOption = screen.getByTestId('slash-command-option-app-github')
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

  test('keeps cloud references out of the root menu and filters them by query', async () => {
    const textareaRef = createRef<HTMLElement>()
    const cloudCandidates: ComposerCloudMentionCandidate[] = [
      {
        kind: 'cloud',
        key: 'cloud-project:11',
        title: '云空间',
        description: '当前云项目的共享内容',
        metaLabel: '云空间',
        testId: 'cloud-project-11',
        enabled: true,
        reference: '[$云空间](cloud://projects/11)',
        searchAliases: ['cloud'],
      },
      {
        kind: 'cloud',
        key: 'cloud-file:42',
        title: 'README.md',
        description: 'README.md',
        metaLabel: '云空间',
        testId: 'cloud-file-42',
        enabled: true,
        reference: '[$README.md](cloud://projects/11/files/42)',
        searchAliases: ['README.md'],
      },
    ]

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
        cloudMentionCandidates={cloudCandidates}
      />
    )
    const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      editor.value = '@'
      editor.focus()
    })

    // Cloud candidates stay out of the root menu; there is no drill entry.
    await screen.findByTestId('mention-files-action')
    expect(screen.queryByTestId('mention-cloud-space')).toBeNull()
    expect(screen.queryByText('README.md')).not.toBeInTheDocument()

    // They surface through plain query filtering instead.
    act(() => {
      editor.value = '@README'
    })
    expect(await screen.findByTestId('cloud-reference-option-cloud-file-42')).toBeInTheDocument()
    expect(screen.getByTestId('local-skill-source-cloud-file-42')).toBeInTheDocument()
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

    await screen.findByTestId('workspace-mention-option-0')
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

  test('adds a selected folder as an atomic composer reference', async () => {
    const textareaRef = createRef<HTMLElement>()
    const workspaceTarget: WorkspaceTarget = {
      deviceId: 'remote-device',
      path: '/workspace/project',
      source: 'project',
      workspaceSource: 'local',
    }
    const workspaceFileApi: WorkspaceFileApi = {
      listWorkspaceEntries: vi.fn(),
      searchWorkspaceEntries: vi.fn(),
      readWorkspaceTextFile: vi.fn(),
    }
    nativeWorkspacePickerMocks.open.mockResolvedValue([
      {
        path: '/workspace/project/frontend',
        isDirectory: true,
      },
    ])

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
          workspaceFileApi={workspaceFileApi}
        />
      )
    }

    render(<Harness />)
    const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      editor.value = '@'
      editor.focus()
    })
    fireEvent.click(await screen.findByTestId('mention-files-action'))

    await waitFor(() => {
      expect(nativeWorkspacePickerMocks.open).toHaveBeenCalledWith('/workspace/project')
      expect(editor.value).toContain('[$frontend](folder://')
      expect(screen.getByTestId('composer-path-chip-frontend')).toHaveAttribute(
        'data-composer-path-kind',
        'folder'
      )
      expect(screen.getByTestId('composer-path-chip-frontend')).toHaveTextContent('frontend')
    })
  })

  test('shows the cloud space entries in the @ menu when cloud is enabled', async () => {
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
      editor.value = '@'
      editor.focus()
    })

    expect(await screen.findByTestId('mention-cloud-space-direct-action')).toHaveTextContent(
      '项目空间'
    )
    expect(screen.getByTestId('mention-cloud-projects-action')).toHaveTextContent('项目空间列表')
    expect(screen.queryByTestId('mention-cloud-create-action')).toBeNull()
    expect(screen.queryByTestId('mention-cloud-space')).toBeNull()
  })

  test('hides the cloud space entries when cloud is disabled', async () => {
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
          cloudProjectCandidates={[cloudProjectCandidate(WEBSITE_PROJECT)]}
          onSelectCloudProject={vi.fn()}
        />
      )
    }

    render(<Harness />)
    const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      editor.value = '@'
      editor.focus()
    })

    await screen.findByTestId('mention-files-action')
    expect(screen.queryByTestId('mention-cloud-space-direct-action')).toBeNull()
    expect(screen.queryByTestId('mention-cloud-projects-action')).toBeNull()
  })

  test('inserts the generic cloud space chip from the direct row', async () => {
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
          cloudProjectCandidates={[cloudProjectCandidate(WEBSITE_PROJECT)]}
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

    fireEvent.click(await screen.findByTestId('mention-cloud-space-direct-action'))
    await waitFor(() => expect(editor.value).toBe('[$项目空间](cloud://projects) '))
    // The generic reference never binds a project.
    expect(onSelectCloudProject).not.toHaveBeenCalled()
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

  test('filters cloud project spaces with the @项目空间: colon syntax', async () => {
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
      editor.value = '@项目空间:官'
      editor.focus()
    })

    // The direct row stays pinned above the filtered project candidates.
    expect(await screen.findByTestId('mention-cloud-space-direct-action')).toBeInTheDocument()
    expect(await screen.findByTestId('cloud-reference-option-cloud-project-space-7'))
    expect(screen.queryByTestId('cloud-reference-option-cloud-project-space-9')).toBeNull()

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

  test('filters cloud project spaces with the typed scope @项目空间 keyword', async () => {
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
      editor.value = '@项目空间 官'
      editor.focus()
    })

    expect(await screen.findByTestId('cloud-reference-option-cloud-project-space-7'))
    expect(screen.queryByTestId('cloud-reference-option-cloud-project-space-9')).toBeNull()

    fireEvent.click(screen.getByTestId('cloud-reference-option-cloud-project-space-7'))
    await waitFor(() => expect(editor.value).toBe('[$项目空间:官网改版](cloud://projects/7) '))
    expect(onSelectCloudProject).toHaveBeenCalledWith(WEBSITE_PROJECT)
  })

  test('filters bound cloud space candidates inline with todo status badges', async () => {
    const textareaRef = createRef<HTMLElement>()
    const cloudCandidates: ComposerCloudMentionCandidate[] = [
      {
        kind: 'cloud',
        key: 'cloud-project:11',
        title: '整个空间',
        description: '共享文件 + 看板全部内容',
        metaLabel: '云空间',
        testId: 'cloud-project-11',
        enabled: true,
        reference: '[$整个空间](cloud://projects/11)',
        searchAliases: ['cloud'],
      },
      {
        kind: 'cloud',
        key: 'cloud-todo:WEG-18',
        title: 'WEG-18',
        description: '接入新版登录页',
        metaLabel: '云空间',
        testId: 'cloud-todo-WEG-18',
        enabled: true,
        reference: '[$任务:WEG-18](cloud://projects/11/todos/WEG-18)',
        searchAliases: ['接入新版登录页'],
        statusLabel: '进行中',
      },
      {
        kind: 'cloud',
        key: 'cloud-file:42',
        title: 'README.md',
        description: 'README.md',
        metaLabel: '云空间',
        testId: 'cloud-file-42',
        enabled: true,
        reference: '[$README.md](cloud://projects/11/files/42)',
        searchAliases: ['README.md'],
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
          cloudMentionCandidates={cloudCandidates}
        />
      )
    }

    render(<Harness />)
    const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      editor.value = '@'
      editor.focus()
    })

    // The bound-space drill entry is gone from the root menu.
    expect(screen.queryByTestId('mention-cloud-space')).toBeNull()

    // Typing a query filters the bound space candidates inline instead.
    act(() => {
      editor.value = '@WEG'
    })

    const todoRow = await screen.findByTestId('cloud-reference-option-cloud-todo-WEG-18')
    expect(todoRow).toHaveTextContent('接入新版登录页')
    expect(screen.getByTestId('cloud-reference-status-cloud-todo-WEG-18')).toHaveTextContent(
      '进行中'
    )

    fireEvent.click(todoRow)
    await waitFor(() =>
      expect(editor.value).toBe('[$任务:WEG-18](cloud://projects/11/todos/WEG-18) ')
    )
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
