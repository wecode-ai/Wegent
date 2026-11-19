// @vitest-environment jsdom

import { act } from 'react'
import { createAgent } from '@ui-sdk/react/agent'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceCreateDialog } from './WorkspaceCreateDialog'

const messages = {
  createWorkspace: 'Create cloud space',
  creatingWorkspace: 'Creating…',
  createWorkspaceFailed: 'Failed to create cloud space. Please try again.',
  cloudStorageNotice: 'Stored in the cloud',
  name: 'Name',
  description: 'Description',
  owner: 'Owner',
  personalOwner: 'Personal',
  ownerHint: 'Default resource owner',
  cancel: 'Cancel',
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('WorkspaceCreateDialog', () => {
  let container: HTMLDivElement
  let root: Root
  const onClose = vi.fn()

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    onClose.mockClear()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  function byTestId<T extends HTMLElement = HTMLButtonElement>(id: string): T {
    return container.querySelector<T>(`[data-testid="${id}"]`)!
  }

  async function render(onCreate: (input: { name: string }) => Promise<void>) {
    await act(async () => {
      root.render(
        <WorkspaceCreateDialog
          messages={messages}
          onCreate={onCreate}
          onClose={onClose}
          ownerOptions={[
            { label: 'Personal', namespace: 'default' },
            { label: 'Engineering', namespace: 'engineering' },
          ]}
        />
      )
    })
  }

  async function change(id: string, value: string) {
    const input = byTestId<HTMLInputElement>(id)
    if (input.getAttribute('role') === 'combobox') {
      await act(async () => input.click())
      const result = await createAgent().act({
        steps: [
          {
            ref: input.getAttribute('aria-label')!,
            action: 'setValue',
            args: [value === 'engineering' ? 'Engineering' : 'Personal'],
          },
        ],
      })
      await act(async () => {})
      expect(result.ok, result.error?.message).toBe(true)
      return
    }
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!.call(
        input,
        value
      )
      input.dispatchEvent(
        new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })
      )
    })
  }

  async function click(id: string) {
    await act(async () => byTestId(id).click())
  }

  it('shows pending status and prevents duplicate submission until persistence completes', async () => {
    const pending = deferred()
    const onCreate = vi.fn(() => pending.promise)
    await render(onCreate)
    expect(byTestId('collaboration-workspace-create-confirm').disabled).toBe(true)
    await change('collaboration-workspace-name-input', '  New space  ')
    await change('collaboration-workspace-description-input', '  Description  ')
    await change('collaboration-workspace-owner-select', 'engineering')

    await click('collaboration-workspace-create-confirm')

    expect(container.querySelector('[role="status"]')?.textContent).toBe(messages.creatingWorkspace)
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-busy')).toBe('true')
    expect(byTestId('collaboration-workspace-create-confirm').disabled).toBe(true)
    expect(byTestId('collaboration-workspace-create-cancel').disabled).toBe(true)
    expect(byTestId<HTMLInputElement>('collaboration-workspace-name-input').disabled).toBe(true)
    await click('collaboration-workspace-create-confirm')
    await click('collaboration-workspace-create-cancel')
    const cancel = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () =>
      container.querySelector<HTMLElement>('[role="dialog"]')!.dispatchEvent(cancel)
    )
    expect(cancel.defaultPrevented).toBe(true)
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      name: 'New space',
      description: 'Description',
      namespace: 'engineering',
    })
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => pending.resolve())
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(byTestId('collaboration-workspace-create-confirm').disabled).toBe(false)
  })

  it('opens an SDK modal, focuses its name field and restores the opener on close', async () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    try {
      await render(vi.fn().mockResolvedValue(undefined))
      const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
      expect(dialog.getAttribute('aria-modal')).toBe('true')
      expect(document.activeElement).toBe(byTestId('collaboration-workspace-name-input'))
      await act(async () =>
        dialog.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
        )
      )
      expect(onClose).toHaveBeenCalledOnce()

      await act(async () => root.render(null))
      expect(dialog.isConnected).toBe(false)
      expect(document.activeElement).toBe(opener)
    } finally {
      opener.remove()
    }
  })

  it.each([
    ['collaboration-workspace-name-input', 'Corrected space'],
    ['collaboration-workspace-description-input', 'Corrected description'],
    ['collaboration-workspace-owner-select', 'engineering'],
  ])('clears stale creation errors when editing %s', async (field, value) => {
    await render(vi.fn().mockRejectedValue(new Error('Invalid workspace')))
    await change('collaboration-workspace-name-input', 'New space')
    await click('collaboration-workspace-create-confirm')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Invalid workspace')

    await change(field, value)

    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it.each([
    [new Error('Workspace could not be created'), 'Workspace could not be created'],
    [null, messages.createWorkspaceFailed],
  ])(
    'retains input after failure and allows a successful retry (%s)',
    async (failure, expectedError) => {
      const pending = deferred()
      const onCreate = vi.fn().mockRejectedValueOnce(failure).mockReturnValueOnce(pending.promise)
      await render(onCreate)
      await change('collaboration-workspace-name-input', 'Retry space')
      await change('collaboration-workspace-owner-select', 'engineering')
      await click('collaboration-workspace-create-confirm')

      expect(container.querySelector('[role="alert"]')?.textContent).toBe(expectedError)
      expect(byTestId<HTMLInputElement>('collaboration-workspace-name-input').value).toBe(
        'Retry space'
      )
      expect(byTestId('collaboration-workspace-owner-select').getAttribute('data-value')).toBe(
        'engineering'
      )
      expect(byTestId('collaboration-workspace-create-confirm').disabled).toBe(false)

      await click('collaboration-workspace-create-confirm')
      expect(container.querySelector('[role="alert"]')).toBeNull()
      expect(onCreate).toHaveBeenCalledTimes(2)
      expect(onCreate).toHaveBeenLastCalledWith({
        name: 'Retry space',
        description: undefined,
        namespace: 'engineering',
      })
      await act(async () => pending.resolve())
      await click('collaboration-workspace-create-cancel')
      expect(onClose).toHaveBeenCalledOnce()
    }
  )
})
