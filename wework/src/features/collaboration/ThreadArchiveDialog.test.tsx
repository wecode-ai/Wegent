import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollaborationIssue, SharedWorkspaceApi } from '@wegent/collaboration'
import { ThreadArchiveDialog } from './ThreadArchiveDialog'

const originalDialog = Object.getOwnPropertyDescriptors(HTMLDialogElement.prototype)
const parent = {
  id: 'parent',
  title: 'Parent',
  cloud_project_id: 'group',
  group_id: 'group',
} as CollaborationIssue
const child = { ...parent, id: 'child', parent_id: parent.id }

beforeEach(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = true
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = false
      },
    },
  })
})
afterEach(() => {
  cleanup()
  for (const key of ['showModal', 'close']) {
    if (originalDialog[key])
      Object.defineProperty(HTMLDialogElement.prototype, key, originalDialog[key])
    else Reflect.deleteProperty(HTMLDialogElement.prototype, key)
  }
})

function show(
  archive: (id: string) => Promise<void>,
  prepare?: (item: CollaborationIssue) => Promise<void>
) {
  const onArchived = vi.fn()
  const view = render(
    <ThreadArchiveDialog
      item={parent}
      items={[parent, child, { ...child, id: 'restricted', can_view_detail: false }]}
      api={{ issues: { archive } } as unknown as SharedWorkspaceApi}
      locale="zh-CN"
      onPrepare={prepare}
      onClose={vi.fn()}
      onArchived={onArchived}
    />
  )
  return { ...view, onArchived }
}

describe('Archiving a group Thread subtree', () => {
  it('prepares every readable descendant before the authoritative archive request', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => {
      release = resolve
    })
    const events: string[] = []
    const prepare = vi.fn(async (item: CollaborationIssue) => {
      events.push(`prepare:${item.id}`)
      if (item.id === child.id) await pending
    })
    const archive = vi.fn(async (id: string) => {
      events.push(`archive:${id}`)
    })
    const { onArchived } = show(archive, prepare)
    expect(screen.getByText('归档后可从当前看板的归档箱恢复。')).toBeVisible()
    fireEvent.click(screen.getByTestId('collaboration-issue-archive-confirm'))
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2))
    expect(archive).not.toHaveBeenCalled()
    expect(screen.getByTestId('collaboration-issue-archive-cancel')).toBeDisabled()
    await act(async () => release())
    await waitFor(() => expect(onArchived).toHaveBeenCalledOnce())
    expect(events).toEqual(['prepare:parent', 'prepare:child', 'archive:parent'])
  })

  it('retains an actionable error and does not archive after stopping work fails', async () => {
    const archive = vi.fn(async () => {})
    const { onArchived } = show(archive, async () => {
      throw new Error('The active task could not stop')
    })
    fireEvent.click(screen.getByTestId('collaboration-issue-archive-confirm'))
    expect(await screen.findByText('The active task could not stop')).toBeVisible()
    expect(archive).not.toHaveBeenCalled()
    expect(onArchived).not.toHaveBeenCalled()
    expect(screen.getByTestId('collaboration-issue-archive-confirm')).toBeEnabled()
  })

  it('does not navigate an unrelated scope after its dialog has unmounted', async () => {
    let finish!: () => void
    const pending = new Promise<void>(resolve => {
      finish = resolve
    })
    const archive = vi.fn(() => pending)
    const { unmount, onArchived } = show(archive)
    fireEvent.click(screen.getByTestId('collaboration-issue-archive-confirm'))
    await waitFor(() => expect(archive).toHaveBeenCalledExactlyOnceWith(parent.id))
    unmount()
    await act(async () => finish())
    expect(onArchived).not.toHaveBeenCalled()
  })
})
