// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentFormDialog } from './AgentFormDialog'
import type { AgentDeleteAction } from './AgentDeleteDialog'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function element<T extends HTMLElement = HTMLButtonElement>(id: string): T {
  const node = container.querySelector<T>(`[data-testid="${id}"]`)
  if (!node) throw new Error(`Missing element: ${id}`)
  return node
}

async function click(id: string) {
  await act(async () => element(id).click())
}

function Editor({ deletion, busy = false }: { deletion?: AgentDeleteAction; busy?: boolean }) {
  const [draft, setDraft] = useState('Unsaved instructions')
  return (
    <AgentFormDialog
      busy={busy}
      deletion={deletion}
      description="Configure agent"
      labels={{
        advanced: 'Advanced',
        advancedDescription: '',
        cancel: 'Cancel',
        close: 'Close',
        owner: 'Owner',
      }}
      onClose={vi.fn()}
      onSave={vi.fn()}
      ownerLabel="Personal"
      prompt={{ label: 'Prompt', onChange: setDraft, testId: 'draft', value: draft }}
      saveDisabled
      saveLabel="Save"
      savingLabel="Saving"
      testIds={{
        backdrop: 'backdrop',
        close: 'close',
        dialog: 'settings',
        error: 'error',
        save: 'save',
      }}
      title="Agent settings"
    />
  )
}

function deletion(onDelete = vi.fn(async () => undefined)): AgentDeleteAction {
  return {
    name: 'Review agent',
    labels: {
      cancel: 'Cancel',
      confirm: 'Delete agent',
      description: 'This cannot be undone.',
      failed: 'Deletion failed',
      pending: 'Deleting…',
    },
    onDelete,
  }
}

describe('Agent settings deletion', () => {
  it('preserves the unsaved editor when confirmation is cancelled', async () => {
    const action = deletion()
    await act(async () => root.render(<Editor deletion={action} />))
    element('settings-delete').focus()
    await click('settings-delete')

    expect(element('settings').hidden).toBe(true)
    expect(element('collaboration-delete-agent-dialog').textContent).toContain(action.name)
    expect(document.activeElement).toBe(element('collaboration-delete-agent-cancel'))
    await click('collaboration-delete-agent-cancel')

    expect(element('settings').hidden).toBe(false)
    expect(element<HTMLTextAreaElement>('draft').value).toBe('Unsaved instructions')
    expect(document.activeElement).toBe(element('settings-delete'))
    expect(action.onDelete).not.toHaveBeenCalled()
  })

  it('shows the deletion failure and allows retrying without losing the draft', async () => {
    const onDelete = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error('Resource is unavailable'))
    await act(async () => root.render(<Editor deletion={deletion(onDelete)} />))
    await click('settings-delete')
    await click('collaboration-delete-agent-confirm')

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Resource is unavailable')
    expect(element<HTMLTextAreaElement>('draft').value).toBe('Unsaved instructions')
    await act(async () =>
      element('collaboration-delete-agent-dialog').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })
      )
    )
    expect(document.activeElement).toBe(element('collaboration-delete-agent-confirm'))
    await click('collaboration-delete-agent-confirm')

    expect(onDelete).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[data-testid="collaboration-delete-agent-dialog"]')).toBeNull()
  })

  it('locks confirmation, cancellation and Escape while deletion is pending', async () => {
    let resolve!: () => void
    const onDelete = vi.fn(
      () =>
        new Promise<void>(done => {
          resolve = done
        })
    )
    await act(async () => root.render(<Editor deletion={deletion(onDelete)} />))
    await click('settings-delete')
    await click('collaboration-delete-agent-confirm')
    await click('collaboration-delete-agent-confirm')
    await click('collaboration-delete-agent-cancel')
    await act(async () =>
      element('collaboration-delete-agent-dialog').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      )
    )

    expect(element<HTMLButtonElement>('collaboration-delete-agent-confirm').disabled).toBe(true)
    expect(document.activeElement).toBe(element('collaboration-delete-agent-dialog'))
    expect(onDelete).toHaveBeenCalledOnce()
    await act(async () => resolve())
    expect(element('settings').hidden).toBe(false)
  })

  it('does not offer deletion without a delete action and disables it while saving', async () => {
    await act(async () => root.render(<Editor />))
    expect(container.querySelector('[data-testid="settings-delete"]')).toBeNull()
    await act(async () => root.render(<Editor deletion={deletion()} busy />))
    expect(element<HTMLButtonElement>('settings-delete').disabled).toBe(true)
  })
})
