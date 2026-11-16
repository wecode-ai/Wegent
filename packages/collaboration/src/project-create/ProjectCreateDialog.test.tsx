// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProjectCreateDialog } from './ProjectCreateDialog'
import { projectCreateLabels } from './labels'
import type { CollaborationProject } from '../types'
import type { ProjectCreateResourceSetup } from './types'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
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
  vi.unstubAllGlobals()
})

const get = <T extends HTMLElement>(id: string) =>
  document.querySelector<T>(`[data-testid="${id}"]`)!
const click = async (id: string) => {
  await act(async () => get(id).click())
}
const changeName = async (value: string) => {
  const input = get<HTMLInputElement>('cloud-project-name')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

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

it('returns from group configuration without closing creation or losing its participants', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
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
  await act(async () => document.dispatchEvent(new Event('selectionchange')))
  expect(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).toHaveLength(1)
  expect(get('cloud-project-name').closest('form')?.hidden).toBe(true)
  await act(async () =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
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
})

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
