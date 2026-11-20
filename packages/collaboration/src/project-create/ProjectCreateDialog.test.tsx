// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProjectCreateDialog } from './ProjectCreateDialog'
import { projectCreateLabels } from './labels'
import type { CollaborationProject } from '../types'
import type { ProjectCreateCollaborationGroupDraft, ProjectCreateResourceSetup } from './types'
import { IncompleteCollaborationGroupGenerationError } from './collaborationGroupDraft'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  // jsdom omits text-range layout APIs used by the focused ProseMirror editor.
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const get = <T extends HTMLElement>(id: string) =>
  document.querySelector<T>(`[data-testid="${id}"]`)!
const click = async (id: string) => {
  await act(async () => get(id).click())
}
const changeInput = async (id: string, value: string) => {
  const input = get<HTMLInputElement>(id)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const changeName = (value: string) => changeInput('cloud-project-name', value)

it.each(['result', 'failure', 'result-back', 'failure-back'])(
  'preserves generation focus through the real deferred composer lifecycle (%s)',
  async outcome => {
    let resolve!: (value: ProjectCreateCollaborationGroupDraft) => void
    let reject!: (reason: Error) => void
    const generated = new Promise<ProjectCreateCollaborationGroupDraft>(
      (resolveValue, rejectValue) => {
        resolve = resolveValue
        reject = rejectValue
      }
    )
    const generate = vi.fn(() => generated)
    await act(async () =>
      root.render(
        <ProjectCreateDialog
          targets={[{ location: 'cloud', create: vi.fn() }]}
          defaultLocation="cloud"
          labels={projectCreateLabels.en}
          allowDingTalkAITable={false}
          onClose={vi.fn()}
          onCreated={vi.fn()}
          resourceSetup={{
            location: 'cloud',
            currentUser: { id: 7, name: 'Me' },
            members: [],
            agents: [
              {
                id: 'one',
                name: 'Agent one',
                owner_type: 'user',
                owner_id: '7',
                owner_name: 'Me',
                status: 'available',
              },
            ],
            groups: [],
            configure: vi.fn(),
            loadCollaborationGroupGenerationModels: async () => ({
              models: [{ modelName: 'unit-model', modelType: 'public' }],
            }),
            generateCollaborationGroupDraft: generate,
          }}
        />
      )
    )
    await click('collaboration-project-create-add-collaborator')
    await click('collaboration-project-create-collaborator-tab-agents')
    await click('collaboration-project-create-agent-one')
    await click('collaboration-project-create-add-collaborator')
    await click('collaboration-project-create-collaborator-tab-groups')
    await click('collaboration-project-create-new-group')
    const editor = get('collaboration-project-create-generation-instructions')
    expect(document.activeElement).toBe(editor)
    const scheduledTimers = vi.spyOn(globalThis, 'setTimeout')
    const cancelTimer = vi.spyOn(globalThis, 'clearTimeout')
    await act(async () =>
      editor.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          keyCode: 13,
          bubbles: true,
          cancelable: true,
        })
      )
    )
    expect(generate).toHaveBeenCalledOnce()
    expect(editor.isConnected).toBe(false)
    const configuration = get('collaboration-project-create-model-picker')
    expect(document.activeElement).toBe(configuration)
    const back = get('collaboration-project-create-configuration-back')
    if (outcome.endsWith('-back')) await act(async () => back.focus())
    await act(async () => {
      if (outcome.startsWith('failure')) reject(new Error('Generation failed'))
      else
        resolve({
          name: 'Review group',
          description: '',
          instructions: 'Review responsibilities',
          leader: { kind: 'human', id: '7', name: 'Me', responsibility: 'Coordinate work' },
          members: [
            {
              kind: 'agent',
              id: 'one',
              name: 'Agent one',
              responsibility: 'Review the implementation',
            },
          ],
          stages: [{ id: 'review', name: 'Review', description: '', assignee: null }],
          executionRequirements: { requiredTags: [] },
        })
    })
    await vi.waitFor(async () => {
      await act(async () => {})
      const target = get(
        outcome.startsWith('failure')
          ? 'collaboration-project-create-generation-instructions'
          : 'collaboration-project-create-group-name'
      )
      expect(target).not.toBeNull()
      expect(document.activeElement).toBe(outcome.endsWith('-back') ? back : target)
      expect(target.getAttribute(outcome.startsWith('failure') ? 'aria-label' : 'role')).toBe(
        outcome.startsWith('failure') ? projectCreateLabels.en.generationRequest : 'button'
      )
    })
    // The shared clock schedules its named tick; composer and test timeouts have separate owners.
    const clockTimers = scheduledTimers.mock.calls.flatMap(([callback], index) =>
      typeof callback === 'function' && callback.name === 'tick'
        ? [scheduledTimers.mock.results[index]]
        : []
    )
    expect(clockTimers).not.toHaveLength(0)
    for (const timer of clockTimers) {
      if (timer.type === 'return') expect(cancelTimer).toHaveBeenCalledWith(timer.value)
    }
  }
)

it.each(['zh-CN', 'en'] as const)(
  'keeps an incomplete generation as a localized, stopped preview (%s)',
  async locale => {
    const labels = projectCreateLabels[locale]
    const generate: NonNullable<ProjectCreateResourceSetup['generateCollaborationGroupDraft']> =
      vi.fn(async (_input, _progress, onEvent) => {
        onEvent?.({
          type: 'participant_responsibility',
          kind: 'human',
          id: '7',
          text: 'Partial responsibility',
        })
        throw new IncompleteCollaborationGroupGenerationError(['principles', 'stages'])
      })
    await act(async () =>
      root.render(
        <ProjectCreateDialog
          targets={[{ location: 'cloud', create: vi.fn() }]}
          defaultLocation="cloud"
          labels={labels}
          allowDingTalkAITable={false}
          onClose={vi.fn()}
          onCreated={vi.fn()}
          host={{ formatError: () => 'Generic host error' }}
          resourceSetup={{
            location: 'cloud',
            currentUser: { id: 7, name: 'Me' },
            members: [],
            agents: ['one', 'two'].map(id => ({
              id,
              name: id,
              owner_type: 'user',
              owner_id: '7',
              owner_name: 'Me',
              status: 'available',
            })),
            groups: [],
            configure: vi.fn(),
            loadCollaborationGroupGenerationModels: async () => ({
              models: [{ modelName: 'unit-model', modelType: 'public' }],
            }),
            generateCollaborationGroupDraft: generate,
          }}
        />
      )
    )
    for (const id of ['one', 'two']) {
      await click('collaboration-project-create-add-collaborator')
      await click('collaboration-project-create-collaborator-tab-agents')
      await click(`collaboration-project-create-agent-${id}`)
    }
    await click('collaboration-project-create-organize-group')
    const editor = get('collaboration-project-create-generation-instructions')
    const instructions = editor.textContent
    expect(editor.getAttribute('aria-label')).toBe(labels.generationRequest)
    await click('collaboration-project-create-generate-group')
    const configuration = get('collaboration-project-create-model-picker')
    expect(configuration.querySelector('[role="alert"]')?.textContent).toBe(
      labels.generationIncomplete.replace(
        '{sections}',
        [labels.allocationPrinciples, labels.generatedWorkflow].join(
          locale === 'zh-CN' ? '、' : ', '
        )
      )
    )
    expect(configuration.textContent).toContain(labels.partialGenerationPreview)
    expect(configuration.textContent).toContain('Partial responsibility')
    expect(configuration.querySelector('.collaboration-spin')).toBeNull()
    expect(
      document.querySelector('[data-testid="collaboration-project-create-apply-group"]')
    ).toBeNull()
    expect(get('collaboration-project-create-generation-status').textContent).toBe('')
    expect(editor.textContent).toBe(instructions)
    expect(get<HTMLButtonElement>('collaboration-project-create-generate-group').disabled).toBe(
      false
    )
  }
)

it('locates an invalid repository even when advanced settings were collapsed', async () => {
  const create = vi.fn()
  await act(async () =>
    root.render(
      <ProjectCreateDialog
        targets={[{ location: 'cloud', create }]}
        defaultLocation="cloud"
        labels={projectCreateLabels.en}
        allowDingTalkAITable={false}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />
    )
  )
  await changeName('Keep the project draft')
  await click('collaboration-project-create-advanced')
  await click('cloud-project-task-provider-github')
  await changeInput('cloud-project-provider-repository', 'invalid-repository')
  await click('collaboration-project-create-advanced')
  await click('cloud-project-create-confirm')
  const input = get<HTMLInputElement>('cloud-project-provider-repository')
  expect(get('collaboration-project-create-advanced').getAttribute('aria-expanded')).toBe('true')
  expect(document.activeElement).toBe(input)
  expect(input.getAttribute('aria-invalid')).toBe('true')
  const errorId = input.getAttribute('aria-describedby')!.split(' ').at(-1)!
  expect(document.getElementById(errorId)?.textContent).toBe(
    projectCreateLabels.en.repositoryInvalid
  )
  expect(get<HTMLButtonElement>('cloud-project-create-confirm').disabled).toBe(true)
  expect(create).not.toHaveBeenCalled()
  await changeInput('cloud-project-provider-repository', 'https://github.com/owner/repository')
  expect(input.getAttribute('aria-invalid')).toBeNull()
  expect(get<HTMLButtonElement>('cloud-project-create-confirm').disabled).toBe(false)
  expect(get<HTMLInputElement>('cloud-project-name').value).toBe('Keep the project draft')
})

it.each(['zh-CN', 'en'] as const)(
  'associates %s name validation with its field and respects storage limits',
  async locale => {
    const create = vi.fn()
    await act(async () =>
      root.render(
        <ProjectCreateDialog
          targets={[
            { location: 'cloud', create },
            { location: 'local', create },
          ]}
          defaultLocation="cloud"
          labels={projectCreateLabels[locale]}
          allowDingTalkAITable={false}
          onClose={vi.fn()}
          onCreated={vi.fn()}
        />
      )
    )
    const input = get<HTMLInputElement>('cloud-project-name')
    await changeName('x'.repeat(101))
    expect(input.getAttribute('aria-invalid')).toBe('true')
    const error = document.getElementById(input.getAttribute('aria-describedby')!)!
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.textContent).toContain('101')
    expect(error.textContent).toContain('100')
    expect(get<HTMLButtonElement>('cloud-project-create-confirm').disabled).toBe(true)
    expect(input.getAttribute('maxlength')).toBeNull()
    await click('cloud-project-location-local')
    expect(input.getAttribute('aria-invalid')).toBeNull()
    expect(input.value).toHaveLength(101)
    expect(get<HTMLButtonElement>('cloud-project-create-confirm').disabled).toBe(false)
    await click('cloud-project-location-cloud')
    await changeName('😀'.repeat(100))
    expect(input.getAttribute('aria-describedby')).toBeNull()
    expect(input.value).toBe('😀'.repeat(100))
    expect(get<HTMLButtonElement>('cloud-project-create-confirm').disabled).toBe(false)
    expect(create).not.toHaveBeenCalled()
  }
)

it.each(['Escape', 'close', 'cancel'])(
  'protects a project draft when leaving through %s, then explicitly discards it',
  async action => {
    const onClose = vi.fn(() => root.render(null))
    await act(async () =>
      root.render(
        <ProjectCreateDialog
          targets={[{ location: 'cloud', create: vi.fn() }]}
          defaultLocation="cloud"
          labels={projectCreateLabels['zh-CN']}
          allowDingTalkAITable={false}
          onClose={onClose}
          onCreated={vi.fn()}
        />
      )
    )
    const name = get<HTMLInputElement>('cloud-project-name')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        name,
        'Keep my draft'
      )
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const leave = async () => {
      if (action === 'Escape')
        await act(async () =>
          name.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
          )
        )
      else
        await click(
          action === 'close'
            ? 'collaboration-project-create-close'
            : 'collaboration-project-create-cancel'
        )
    }
    await leave()
    const confirmation = get('collaboration-project-create-discard')
    const keep = confirmation.querySelector<HTMLButtonElement>(
      '[data-testid="collaboration-project-create-configuration-back"]'
    )!
    expect(onClose).not.toHaveBeenCalled()
    expect(name.closest('form')?.hidden).toBe(true)
    expect(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).toHaveLength(1)
    expect(document.activeElement).toBe(keep)
    await act(async () =>
      keep.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    )
    expect(
      document.querySelector('[data-testid="collaboration-project-create-discard"]')
    ).toBeNull()
    expect(name.closest('form')?.hidden).toBe(false)
    expect(name.value).toBe('Keep my draft')
    expect(onClose).not.toHaveBeenCalled()
    await leave()
    await click('collaboration-project-create-discard-confirm')
    expect(onClose).toHaveBeenCalledOnce()
  }
)

it('explains an incomplete task source while advanced settings are collapsed', async () => {
  await act(async () =>
    root.render(
      <ProjectCreateDialog
        targets={[{ location: 'cloud', create: vi.fn() }]}
        defaultLocation="cloud"
        labels={projectCreateLabels.en}
        allowDingTalkAITable={false}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />
    )
  )
  await click('collaboration-project-create-advanced')
  await click('cloud-project-task-provider-github')
  await click('collaboration-project-create-advanced')
  const advanced = get('collaboration-project-create-advanced')
  expect(advanced.getAttribute('aria-expanded')).toBe('false')
  expect(advanced.textContent).toContain('GitHub')
  expect(advanced.textContent).toContain(projectCreateLabels.en.repositoryRequired)
  expect(get<HTMLButtonElement>('cloud-project-create-confirm').disabled).toBe(true)
  await click('collaboration-project-create-advanced')
  expect(get<HTMLInputElement>('cloud-project-provider-repository').value).toBe('')
})

it.each([false, true])(
  'returns from group configuration with model menu open=%s without losing participants',
  async modelMenuOpen => {
    const onClose = vi.fn()
    const agents: ProjectCreateResourceSetup['agents'] = ['one', 'two'].map(id => ({
      id,
      name: id,
      owner_type: 'user',
      owner_id: '1',
      owner_name: 'Me',
      status: 'available',
    }))
    await act(async () =>
      root.render(
        <ProjectCreateDialog
          targets={[{ location: 'cloud', create: vi.fn() }]}
          defaultLocation="cloud"
          labels={projectCreateLabels['zh-CN']}
          allowDingTalkAITable={false}
          onClose={onClose}
          onCreated={vi.fn()}
          resourceSetup={{
            location: 'cloud',
            currentUser: { id: 1, name: 'Me' },
            members: [],
            agents,
            groups: [],
            configure: vi.fn(),
            generateCollaborationGroupDraft: vi.fn(),
          }}
        />
      )
    )
    for (const agent of agents) {
      await click('collaboration-project-create-add-collaborator')
      await click('collaboration-project-create-collaborator-tab-agents')
      await click(`collaboration-project-create-agent-${agent.id}`)
    }
    const opener = get('collaboration-project-create-organize-group')
    opener.focus()
    await click('collaboration-project-create-organize-group')
    const configuration = get('collaboration-project-create-model-picker')
    expect(configuration.contains(document.activeElement), document.activeElement?.outerHTML).toBe(
      true
    )
    expect(document.activeElement).toBe(get('collaboration-project-create-generation-instructions'))
    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      projectCreateLabels['zh-CN'].generationRequest
    )
    await act(async () => document.dispatchEvent(new Event('selectionchange')))
    expect(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).toHaveLength(1)
    expect(get('cloud-project-name').closest('form')?.hidden).toBe(true)
    if (modelMenuOpen) {
      const editor = get('collaboration-project-create-generation-instructions')
      await click('model-selector-button')
      expect(
        get('model-selector-menu').closest('[role="dialog"]')?.contains(document.activeElement)
      ).toBe(true)
      await act(async () => {
        editor.focus()
        editor.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            keyCode: 27,
            bubbles: true,
            cancelable: true,
          })
        )
      })
      expect(document.querySelector('[data-testid="model-selector-menu"]')).toBeNull()
      expect(get('collaboration-project-create-model-picker')).toBe(configuration)
      expect(document.activeElement).toBe(editor)
      expect(onClose).not.toHaveBeenCalled()
    }
    await act(async () =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          keyCode: 27,
          bubbles: true,
          cancelable: true,
        })
      )
    )
    expect(onClose).not.toHaveBeenCalled()
    expect(
      document.querySelector('[data-testid="collaboration-project-create-model-picker"]')
    ).toBeNull()
    expect(get('cloud-project-name').closest('form')?.hidden).toBe(false)
    expect(document.activeElement).toBe(opener)
    expect(document.querySelector('button[aria-label="取消 one"]')).toBeTruthy()
    expect(document.querySelector('button[aria-label="取消 two"]')).toBeTruthy()
  }
)

it('contains keyboard focus, respects a child dialog and restores the opener on Escape', async () => {
  const opener = document.createElement('button')
  document.body.append(opener)
  opener.focus()
  const onClose = vi.fn(() => root.render(null))
  await act(async () =>
    root.render(
      <ProjectCreateDialog
        targets={[{ location: 'cloud', create: vi.fn() }]}
        defaultLocation="cloud"
        labels={projectCreateLabels['zh-CN']}
        allowDingTalkAITable={false}
        onClose={onClose}
        onCreated={vi.fn()}
      />
    )
  )
  expect(document.activeElement).toBe(get('cloud-project-name'))
  const close = get('collaboration-project-create-close')
  const buttons = [
    ...get('collaboration-project-create-dialog').querySelectorAll<HTMLButtonElement>(
      'button:not(:disabled)'
    ),
  ]
  const last = buttons.at(-1)!
  await act(async () => {
    last.focus()
    last.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      })
    )
  })
  expect(document.activeElement).toBe(close)
  await act(async () =>
    close.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      })
    )
  )
  expect(document.activeElement).toBe(last)

  const child = document.createElement('dialog')
  child.setAttribute('open', '')
  get('collaboration-project-create-dialog').append(child)
  const nativeEscape = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  })
  await act(async () => {
    child.dispatchEvent(nativeEscape)
  })
  expect(onClose).not.toHaveBeenCalled()
  expect(nativeEscape.defaultPrevented).toBe(false)
  child.remove()
  await act(async () =>
    last.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      })
    )
  )
  expect(onClose).toHaveBeenCalledOnce()
  expect(document.activeElement).toBe(opener)
  opener.remove()
})

it.each(['zh-CN', 'en'] as const)(
  'names the %s dialog and preserves public read-only access with restricted issues',
  async locale => {
    const labels = projectCreateLabels[locale]
    const create = vi.fn(async () => ({ id: 'created' }) as CollaborationProject)
    const onClose = vi.fn()
    await act(async () =>
      root.render(
        <ProjectCreateDialog
          targets={[{ location: 'cloud', create }]}
          defaultLocation="cloud"
          labels={labels}
          allowDingTalkAITable={false}
          onClose={onClose}
          onCreated={vi.fn()}
        />
      )
    )

    const dialog = get('collaboration-project-create-dialog')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe(
      labels.title
    )
    expect(get('collaboration-project-create-close').getAttribute('aria-label')).toBe(labels.close)
    expect(get('collaboration-project-create-advanced').textContent).toContain(
      labels.advancedSettingsSummary
    )
    expect(get('cloud-project-visibility-private').getAttribute('aria-pressed')).toBe('true')
    expect(get<HTMLButtonElement>('cloud-project-create-confirm').disabled).toBe(true)

    await click('cloud-project-visibility-public')
    const readOnly = get('cloud-project-public-access-viewer')
    expect(readOnly.tagName).toBe('P')
    expect(readOnly.textContent).toBe(labels.publicReadOnlyDescription)
    await click('cloud-project-default-issue-security-related')
    await act(async () => {
      const name = get<HTMLInputElement>('cloud-project-name')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        name,
        'Review'
      )
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('cloud-project-create-confirm')
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Review',
        visibility: 'public',
        publicAccess: { role: 'Viewer' },
        defaultIssueSecurity: 'related',
      })
    )
  }
)
