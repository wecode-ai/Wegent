import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef, useState } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { LocalDeviceSkill } from '@/types/api'
import type { WorkspaceFileApi, WorkspaceTarget } from '@/types/workspace-files'
import type { ComposerCloudMentionCandidate } from './composerMentionCandidates'
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

describe('ComposerTextarea', () => {
  beforeEach(() => {
    nativeWorkspacePickerMocks.open.mockReset()
    nativeWorkspacePickerMocks.open.mockResolvedValue([])
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

  test('drills into cloud space instead of flattening cloud references', async () => {
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

    expect(await screen.findByTestId('mention-cloud-space')).toBeInTheDocument()
    expect(screen.queryByText('README.md')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('mention-cloud-space'))

    expect(await screen.findByTestId('cloud-reference-option-cloud-file-42')).toBeInTheDocument()
    expect(screen.getByText('返回')).toBeInTheDocument()
    expect(screen.queryByTestId('local-skill-source-cloud-file-42')).not.toBeInTheDocument()
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
})
