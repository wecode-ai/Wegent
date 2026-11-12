import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { ChatGroupApi } from '@/api/chatGroups'
import type { GroupSource } from './CollaborationGroupsSurface'
import { CreateGroupOrThread } from './GroupManagementDialogs'

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
})

function setup() {
  const localCreate = vi.fn<
    (input: { name: string; description: string }) => Promise<{ group: { id: string } }>
  >(async () => ({ group: { id: 'local-group' } }))
  const cloudCreate = vi.fn(async () => ({ group: { id: 'cloud-group' } }))
  const sources = [
    { store: 'local', groups: { create: localCreate } },
    { store: 'cloud', groups: { create: cloudCreate } },
  ].map(source => ({
    ...source,
    groups: source.groups as unknown as ChatGroupApi,
  })) as GroupSource[]
  const onClose = vi.fn()
  const onCreated = vi.fn()
  render(
    <CreateGroupOrThread
      kind="group"
      sources={sources}
      api={null}
      onClose={onClose}
      onCreated={onCreated}
    />
  )
  return { localCreate, cloudCreate, onClose, onCreated }
}

describe('standalone Group creation', () => {
  it.each(['', '   '])('rejects a blank name %j without creating or navigating', name => {
    const { localCreate, cloudCreate, onCreated } = setup()
    fireEvent.change(screen.getByTestId('create-group-name'), { target: { value: name } })
    expect(screen.getByTestId('create-group-submit')).toBeDisabled()
    fireEvent.submit(screen.getByTestId('create-group-dialog'))
    expect(localCreate).not.toHaveBeenCalled()
    expect(cloudCreate).not.toHaveBeenCalled()
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('cancels a filled form without creating a Group', () => {
    const { localCreate, cloudCreate, onClose, onCreated } = setup()
    fireEvent.change(screen.getByTestId('create-group-name'), { target: { value: 'Discard me' } })
    fireEvent.click(screen.getByTestId('create-group-cancel'))
    expect(onClose).toHaveBeenCalledOnce()
    expect(localCreate).not.toHaveBeenCalled()
    expect(cloudCreate).not.toHaveBeenCalled()
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('retains the draft and selected store after rejection and retries that same Group', async () => {
    const { localCreate, cloudCreate, onClose, onCreated } = setup()
    localCreate.mockRejectedValueOnce(new Error('Storage temporarily unavailable'))
    fireEvent.change(screen.getByTestId('create-group-name'), {
      target: { value: '  Release team  ' },
    })
    fireEvent.change(screen.getByTestId('create-group-description'), {
      target: { value: 'Keep this description' },
    })
    fireEvent.change(screen.getByTestId('create-group-store'), { target: { value: 'local' } })
    fireEvent.click(screen.getByTestId('create-group-submit'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Storage temporarily unavailable')
    expect(screen.getByTestId('create-group-name')).toHaveValue('  Release team  ')
    expect(screen.getByTestId('create-group-description')).toHaveValue('Keep this description')
    expect(screen.getByTestId('create-group-store')).toHaveValue('local')
    expect(screen.getByTestId('create-group-submit')).toBeEnabled()
    expect(onCreated).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('create-group-submit'))
    await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith('local', 'local-group'))
    expect(localCreate).toHaveBeenCalledTimes(2)
    for (const [input] of localCreate.mock.calls) {
      expect(input).toEqual({ name: 'Release team', description: 'Keep this description' })
    }
    expect(cloudCreate).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('prevents duplicate submissions and closing while creation is pending', async () => {
    const { cloudCreate, onCreated, onClose } = setup()
    let finish!: (value: { group: { id: string } }) => void
    cloudCreate.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    fireEvent.change(screen.getByTestId('create-group-name'), {
      target: { value: 'Pending group' },
    })
    fireEvent.click(screen.getByTestId('create-group-submit'))
    expect(screen.getByTestId('create-group-submit')).toBeDisabled()
    expect(screen.getByTestId('create-group-cancel')).toBeDisabled()
    expect(screen.getByTestId('collaboration-template-close')).toBeDisabled()
    fireEvent.submit(screen.getByTestId('create-group-dialog'))
    fireEvent.click(screen.getByTestId('create-group-cancel'))
    expect(cloudCreate).toHaveBeenCalledOnce()
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => finish({ group: { id: 'cloud-group' } }))
    expect(onCreated).toHaveBeenCalledExactlyOnceWith('cloud', 'cloud-group')
  })
})
