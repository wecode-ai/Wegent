// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProjectCreateDialog } from './ProjectCreateDialog'
import { projectCreateLabels } from './labels'
import type { CollaborationProject } from '../types'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const get = <T extends HTMLElement>(id: string) =>
  document.querySelector<T>(`[data-testid="${id}"]`)!
const click = async (id: string) => {
  await act(async () => get(id).click())
}

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
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
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
