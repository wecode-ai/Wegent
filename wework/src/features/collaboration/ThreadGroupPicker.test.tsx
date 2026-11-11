import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { ChatGroup, ChatGroupApi } from '@/api/chatGroups'
import '@/i18n'
import { ThreadGroupPicker } from './ThreadGroupPicker'

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
})

const group = { id: 'group', name: 'Design', role: 'Developer', status: 'active' } as ChatGroup

it('abandons the old source request without freezing the next explicit group choice', async () => {
  let resolveFirst!: (value: { group: ChatGroup }) => void
  const firstGet = new Promise<{ group: ChatGroup }>(resolve => {
    resolveFirst = resolve
  })
  const first = {
    list: vi.fn().mockResolvedValue({ items: [group] }),
    get: vi.fn().mockReturnValue(firstGet),
  } as unknown as ChatGroupApi
  const replacement = {
    list: vi.fn().mockResolvedValue({ items: [group] }),
    get: vi.fn().mockResolvedValue({ group: { ...group, version: 2 } }),
  } as unknown as ChatGroupApi
  const onChoose = vi.fn().mockResolvedValue(undefined)
  const props = { scopeKey: 'account/local/project', onChoose, onClose: vi.fn() }
  const view = render(<ThreadGroupPicker {...props} groups={first} />)
  await waitFor(() => expect(screen.getByTestId('thread-create-group-select')).toBeEnabled())
  fireEvent.change(screen.getByTestId('thread-create-group-select'), {
    target: { value: group.id },
  })
  fireEvent.click(screen.getByTestId('thread-create-group-next'))
  await waitFor(() => expect(first.get).toHaveBeenCalledWith(group.id))
  view.rerender(<ThreadGroupPicker {...props} groups={replacement} />)
  await waitFor(() => expect(screen.getByTestId('thread-create-group-next')).toBeEnabled())
  await act(async () => {
    resolveFirst({ group })
    await firstGet
  })
  expect(onChoose).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('thread-create-group-next'))
  await waitFor(() => expect(onChoose).toHaveBeenCalledExactlyOnceWith({ ...group, version: 2 }))
})

describe('Group creation lifetime', () => {
  it('stops before reading or selecting a group when creation completes after closing', async () => {
    let resolveCreation!: (value: { group: ChatGroup }) => void
    const pending = new Promise<{ group: ChatGroup }>(resolve => {
      resolveCreation = resolve
    })
    const groups = {
      list: vi.fn().mockResolvedValue({ items: [] }),
      create: vi.fn().mockReturnValue(pending),
      get: vi.fn(),
    } as unknown as ChatGroupApi
    const onChoose = vi.fn().mockResolvedValue(undefined)
    const view = render(
      <ThreadGroupPicker
        groups={groups}
        scopeKey="account/local/project"
        onChoose={onChoose}
        onClose={vi.fn()}
      />
    )
    fireEvent.change(await screen.findByTestId('thread-create-new-group-name'), {
      target: { value: 'Explicit group' },
    })
    fireEvent.click(screen.getByTestId('thread-create-group-next'))
    await waitFor(() =>
      expect(groups.create).toHaveBeenCalledExactlyOnceWith({ name: 'Explicit group' })
    )
    view.unmount()
    await act(async () => {
      resolveCreation({ group })
      await pending
    })
    expect(groups.get).not.toHaveBeenCalled()
    expect(onChoose).not.toHaveBeenCalled()
  })
})
