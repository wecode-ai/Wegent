// @vitest-environment jsdom
import { act, createRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attachment } from '@wegent/chat-core/runtime'
import { ProjectComposerBody, type ProjectComposerBodyProps } from './ProjectComposerBody'
import { ComposerTextInput } from './ComposerTextInput'
import type { ComposerInputHandle } from './composerInputTypes'
import type { ComposerTransferServices } from './useComposerTransfers'
import { createCollaborationTranslator } from '../i18n'

const textAttachment: Attachment = {
  id: 17,
  filename: 'pasted.txt',
  text_content: 'Restored text',
  file_size: 13,
  file_extension: '.txt',
  mime_type: 'text/plain',
  status: 'ready',
  created_at: '',
  subtask_id: null,
}

describe('shared PC composer body', () => {
  let root: Root
  let container: HTMLDivElement
  let frames: FrameRequestCallback[]
  const input = createRef<ComposerInputHandle>()
  const submit = vi.fn()
  const change = vi.fn()
  const remove = vi.fn()
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    frames = []
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => frames.push(fn))
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
  function Harness({
    buffered = false,
    ...overrides
  }: Partial<ProjectComposerBodyProps> & { buffered?: boolean }) {
    const [value, setValue] = useState('')
    return (
      <ProjectComposerBody
        ref={input}
        translate={createCollaborationTranslator('en')}
        value={value}
        onChange={next => {
          change(next)
          if (!buffered) setValue(next)
        }}
        onSubmit={submit}
        disabled={false}
        isModelSelectionReady
        placeholder="Reply"
        attachments={[]}
        uploadingCount={0}
        attachmentErrorCount={0}
        onFileSelect={vi.fn()}
        onRemoveAttachment={remove}
        renderAttachments={show => (
          <button type="button" data-testid="restore" onClick={() => show(textAttachment)}>
            Restore
          </button>
        )}
        renderEditor={props => <ComposerTextInput {...props} />}
        renderToolbar={props => (
          <button
            type="button"
            data-testid="send"
            disabled={!props.canSend}
            onClick={() => props.onSubmit()}
          >
            Send
          </button>
        )}
        {...overrides}
      />
    )
  }
  async function mount(props: Partial<ProjectComposerBodyProps> & { buffered?: boolean } = {}) {
    await act(async () => root.render(<Harness {...props} />))
  }
  function button(id: string) {
    return container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!
  }
  async function setValue(value: string) {
    await act(async () => input.current!.setValue(value))
  }
  async function click(id: string) {
    await act(async () => button(id).click())
  }
  async function enter() {
    await act(async () =>
      input.current!.element!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    )
  }
  async function drop(target: 'surface' | 'editor' = 'surface') {
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: ['Files'], files: [new File(['data'], 'context.txt')], getData: () => '' },
    })
    const element =
      target === 'surface' ? button('project-chat-composer-form') : input.current!.element!
    await act(async () => element.dispatchEvent(event))
  }
  it('submits live editor text before the outer buffered draft acknowledges it', async () => {
    await mount({ buffered: true })
    await setValue('Newest draft')
    expect(change).toHaveBeenCalledWith('Newest draft')
    expect(button('send').disabled).toBe(false)
    await click('send')
    expect(submit).toHaveBeenCalledWith('Newest draft', undefined)
  })
  it('restores text attachments into the live draft and focuses the exact editor', async () => {
    await mount({ buffered: true, attachments: [textAttachment] })
    await setValue('Unflushed text')
    await click('restore')
    expect(input.current!.getValue()).toBe('Unflushed text\nRestored text')
    expect(remove).toHaveBeenCalledWith(17)
    await act(async () => {
      frames.splice(0).forEach(fn => fn(0))
    })
    expect(document.activeElement).toBe(input.current!.element)
    await click('send')
    expect(submit).toHaveBeenCalledWith('Unflushed text\nRestored text', undefined)
  })
  it.each([{ isModelSelectionReady: false }, { submitDisabled: true }, { disabled: true }])(
    'blocks keyboard and button submission under %j',
    async overrides => {
      await mount({ value: 'Existing draft', ...overrides })
      expect(button('send').disabled).toBe(true)
      await enter()
      await click('send')
      expect(submit).not.toHaveBeenCalled()
    }
  )
  it('requires message text for side conversations while allowing attachment-only main composers', async () => {
    await mount({ attachments: [textAttachment], requireText: true })
    expect(button('send').disabled).toBe(true)
    await enter()
    expect(submit).not.toHaveBeenCalled()
    await mount({ attachments: [textAttachment] })
    expect(button('send').disabled).toBe(false)
    await click('send')
    expect(submit).toHaveBeenCalledWith('', undefined)
  })
  it('resolves drops on the entire surface against the latest draft', async () => {
    let resolve!: (result: Awaited<ReturnType<ComposerTransferServices['resolveTransfer']>>) => void
    const services: ComposerTransferServices = {
      hasPathTransfer: () => false,
      resolveTransfer: vi.fn(
        () =>
          new Promise(done => {
            resolve = done
          })
      ),
    }
    const file = new File(['data'], 'context.txt')
    const select = vi.fn()
    await mount({ transferServices: services, onFileSelect: select, buffered: true })
    await drop()
    await setValue('Typed during drop')
    await act(async () =>
      resolve({
        referenceEntries: [{ path: '/project/a.ts', isDirectory: false }],
        attachmentFiles: [file],
      })
    )
    expect(input.current!.getValue()).toContain('Typed during drop\n')
    expect(input.current!.getValue()).toContain('[$a.ts](file://%2Fproject%2Fa.ts)')
    expect(select).toHaveBeenCalledWith([file])
  })
  it.each([
    ['resolve', 'surface'],
    ['upload', 'surface'],
    ['resolve', 'editor'],
    ['upload', 'editor'],
  ] as const)('shows %s failures from the %s and preserves the draft', async (stage, target) => {
    const services: ComposerTransferServices = {
      hasPathTransfer: () => false,
      resolveTransfer:
        stage === 'resolve'
          ? vi.fn().mockRejectedValue(new Error('Transfer failed'))
          : vi.fn().mockResolvedValue({
              referenceEntries: [],
              attachmentFiles: [new File(['data'], 'context.txt')],
            }),
    }
    await mount({
      value: 'Keep me',
      transferServices: services,
      onFileSelect: vi.fn().mockRejectedValue(new Error('Transfer failed')),
    })
    await drop(target)
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Transfer failed')
    expect(input.current!.getValue()).toBe('Keep me')
  })
})
