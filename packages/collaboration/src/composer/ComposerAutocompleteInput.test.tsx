// @vitest-environment jsdom
import { act, createRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposerAutocompleteInput } from './ComposerAutocompleteInput'
import type { ComposerAutocompleteInputProps } from './composerAutocompleteInputTypes'
import type { ComposerInputHandle } from './composerInputTypes'
import { createCollaborationTranslator } from '../i18n'
import { Package } from 'lucide-react'

const translate = createCollaborationTranslator('zh-CN')
const gmail = {
  name: 'gmail',
  path: '/skills/gmail/SKILL.md',
  source: 'codex',
  description: 'Email',
}
const listSkills = async () => [gmail]

describe('shared autocomplete controller in a browser host', () => {
  let root: Root
  let container: HTMLDivElement
  const input = createRef<ComposerInputHandle>()
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    // jsdom has no text-range geometry; ProseMirror reads it when restoring selection.
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [],
    })
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect(),
    })
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
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
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })
  const element = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
  function Harness(props: Partial<ComposerAutocompleteInputProps>) {
    const [value, onChange] = useState('')
    return (
      <ComposerAutocompleteInput
        ref={input}
        value={value}
        onChange={onChange}
        onSubmit={vi.fn()}
        canSend={false}
        placeholder="Reply"
        testId="editor"
        rows={2}
        textareaRef={createRef()}
        className=""
        translate={translate}
        {...props}
      />
    )
  }
  async function mount(props: Partial<ComposerAutocompleteInputProps> = {}) {
    await act(async () => root.render(<Harness {...props} />))
  }
  async function type(value: string) {
    await act(async () => {
      input.current!.setValue(value)
      input.current!.focus()
      element('editor').dispatchEvent(
        new KeyboardEvent('keyup', { key: value.at(-1), bubbles: true })
      )
    })
  }
  async function click(id: string) {
    expect(element(id)).not.toBeNull()
    await act(async () => element(id).click())
  }
  it('restricts Issue autocomplete to members and Issues and treats slash as plain text', async () => {
    const plan = vi.fn()
    await mount({
      mentionScope: 'external',
      onListLocalSkills: listSkills,
      onSetPlanMode: plan,
      externalMentionCandidates: [
        {
          id: 'u1',
          type: 'user',
          title: 'Alice',
          metaLabel: 'Member',
          reference: '[$@Alice](wework-member://p/1)',
          testId: 'member-alice',
        },
        {
          id: 'a1',
          type: 'agent',
          title: 'Engineer',
          metaLabel: 'Agent',
          reference: '[$@Engineer](wework-agent://p/a1)',
          testId: 'agent-engineer',
        },
        {
          id: 'g1',
          type: 'group',
          title: 'Delivery',
          metaLabel: 'Team',
          reference: '[$@Delivery](wework-group://p/g1)',
          testId: 'group-delivery',
        },
        {
          id: 'i1',
          type: 'issue',
          title: '#1 Fix login',
          metaLabel: 'Issue',
          reference: '[$#1 Fix login](wework-issue://p/i1)',
          testId: 'issue-login',
        },
      ],
    })
    await type('@')
    expect(element('member-alice')).not.toBeNull()
    expect(element('agent-engineer')).not.toBeNull()
    expect(element('group-delivery')).not.toBeNull()
    expect(element('issue-login')).toBeNull()
    expect(container.textContent).not.toContain('文件和文件夹')
    expect(container.textContent).not.toContain('计划模式')
    expect(container.textContent).not.toContain('Gmail')
    await type('#login')
    expect(element('agent-engineer')).toBeNull()
    expect(element('group-delivery')).toBeNull()
    expect(element('member-alice')).toBeNull()
    await click('issue-login')
    expect(input.current!.getValue()).toContain('wework-issue://p/i1')
    await type('/plan')
    expect(container.querySelector('[data-testid^="slash-command-option-"]')).toBeNull()
    expect(input.current!.getValue()).toBe('/plan')
    expect(plan).not.toHaveBeenCalled()
  })
  it('inserts a picker reference at the live caret without overwriting following text', async () => {
    await mount()
    await act(async () => {
      input.current!.setValue('Review tomorrow', 6)
      input.current!.insertReference('[$PDF](plugin://pdf@tools)')
      input.current!.focus()
    })
    expect(input.current!.getValue()).toBe('Review [$PDF](plugin://pdf@tools)  tomorrow')
    expect(document.activeElement).toBe(element('editor'))
  })
  it('closes an existing autocomplete menu after picker insertion', async () => {
    await mount({ onListLocalSkills: listSkills })
    await type('$gmail')
    expect(element('local-skill-option-gmail')).not.toBeNull()
    await act(async () => input.current!.insertReference('[$PDF](plugin://pdf@tools)'))
    expect(element('local-skill-option-gmail')).toBeNull()
    expect(input.current!.getValue()).toContain('[$PDF](plugin://pdf@tools)')
  })
  it('selects a real skill with its original reference and localized scope', async () => {
    await mount({ onListLocalSkills: listSkills })
    await type('$gmail')
    expect(element('local-skill-option-gmail').textContent).toContain('个人')
    await act(async () =>
      element('editor').dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        })
      )
    )
    expect(input.current!.getValue()).toBe('[$gmail](/skills/gmail/SKILL.md) ')
    expect(element('local-skill-autocomplete')).toBeNull()
  })
  it('opens the native slash model menu and selects the original model', async () => {
    const model = {
      name: 'model-a',
      displayName: 'Model A',
      type: 'user' as const,
    }
    const onSelectModel = vi.fn()
    await mount({ models: [model], onSelectModel })
    await type('/model')
    await click('slash-command-option-model')
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item =>
      item.textContent?.includes('Model A')
    )!
    expect(button).toBeDefined()
    await act(async () => button.click())
    expect(onSelectModel).toHaveBeenCalledWith(model)
    expect(input.current!.getValue()).toBe('')
  })
  it('does not delete the trigger when keyboard selection reaches an unavailable file picker', async () => {
    await mount()
    await type('@')
    const files = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item =>
      item.textContent?.includes('文件和文件夹')
    )!
    expect(files.disabled).toBe(true)
    await act(async () =>
      element('editor').dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        })
      )
    )
    expect(input.current!.getValue()).toBe('@')
  })
  it('sends selected files to attachments without replacing text typed while the picker is open', async () => {
    const file = new File(['# test'], 'test.md', { type: 'text/markdown' })
    const image = new File(['test image'], 'test.png', { type: 'image/png' })
    let finish!: (result: { attachmentFiles: File[]; referenceEntries: [] }) => void
    const onPickWorkspacePaths = vi.fn(
      () =>
        new Promise<{
          attachmentFiles: File[]
          referenceEntries: []
        }>(resolve => {
          finish = resolve
        })
    )
    const onPasteFiles = vi.fn()
    await mount({ onPickWorkspacePaths, onPasteFiles })
    await type('test @')
    await click('mention-files-action')
    await type('test continued')
    await act(async () => finish({ attachmentFiles: [file, image], referenceEntries: [] }))
    expect(onPasteFiles).toHaveBeenCalledExactlyOnceWith([file, image])
    expect(input.current!.getValue()).toBe('test continued')
    expect(document.activeElement).toBe(element('editor'))
  })
  it('keeps directory selections as references while attaching selected files', async () => {
    const file = new File(['test'], 'test.md')
    const onPasteFiles = vi.fn()
    await mount({
      onPasteFiles,
      onPickWorkspacePaths: async () => ({
        attachmentFiles: [file],
        referenceEntries: [{ path: '/test/folder', isDirectory: true }],
      }),
    })
    await type('@')
    await click('mention-files-action')
    expect(onPasteFiles).toHaveBeenCalledExactlyOnceWith([file])
    expect(input.current!.getValue()).toContain('folder')
    expect(input.current!.getValue()).not.toContain('test.md')
  })
  it('leaves the draft unchanged and adds no attachment when the picker is cancelled', async () => {
    const onPasteFiles = vi.fn()
    await mount({
      onPasteFiles,
      onPickWorkspacePaths: async () => ({
        attachmentFiles: [],
        referenceEntries: [],
      }),
    })
    await type('test @')
    await click('mention-files-action')
    expect(input.current!.getValue()).toBe('test ')
    expect(onPasteFiles).not.toHaveBeenCalled()
  })
  it('reports a file read failure and permits retry through the same picker', async () => {
    const file = new File(['test'], 'test.md')
    const onPasteFiles = vi.fn()
    const onPickWorkspacePaths = vi
      .fn()
      .mockRejectedValueOnce(new Error('Test file could not be read'))
      .mockResolvedValue({ attachmentFiles: [file], referenceEntries: [] })
    await mount({ onPasteFiles, onPickWorkspacePaths })
    await type('@')
    await click('mention-files-action')
    expect(container.textContent).toContain('Test file could not be read')
    expect(onPasteFiles).not.toHaveBeenCalled()
    await type('@')
    await click('mention-files-action')
    expect(onPasteFiles).toHaveBeenCalledExactlyOnceWith([file])
    expect(container.textContent).not.toContain('Test file could not be read')
  })
  it('shows an extension failure and clears it when the command succeeds on retry', async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error('Extension offline'))
      .mockResolvedValue(undefined)
    await mount({
      contributedSlashCommands: [
        {
          id: 'review',
          title: 'Review',
          testId: 'review',
          Icon: Package,
          extensionCommand: { command: 'review', menuId: 'review' },
        },
      ],
      onExecuteCommand: execute,
    })
    await type('/review')
    await click('slash-command-option-review')
    expect(container.textContent).toContain('Extension offline')
    await type('/review')
    await click('slash-command-option-review')
    expect(execute).toHaveBeenCalledTimes(2)
    expect(container.textContent).not.toContain('Extension offline')
  })
  it('inserts a path returned by the addressed workspace search', async () => {
    const onPasteFiles = vi.fn()
    const searchWorkspaceEntries = vi.fn().mockResolvedValue({
      files: [
        {
          root: '/repo',
          path: 'README.md',
          fileName: 'README.md',
          matchType: 'file',
          score: 1,
        },
      ],
    })
    await mount({
      onPasteFiles,
      workspaceTarget: { deviceId: 'device-b', path: '/repo' },
      workspaceFileApi: { searchWorkspaceEntries },
    })
    await type('@README')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100))
    })
    expect(searchWorkspaceEntries).toHaveBeenCalledWith(
      'device-b',
      '/repo',
      'README',
      expect.any(String)
    )
    const path = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item =>
      item.textContent?.includes('README.md')
    )!
    expect(path).toBeDefined()
    await act(async () => path.click())
    expect(input.current!.getValue()).toBe('[$README.md](file://%2Frepo%2FREADME.md) ')
    expect(onPasteFiles).not.toHaveBeenCalled()
  })
})
