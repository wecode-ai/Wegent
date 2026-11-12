import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  CollaborationExecutionEnvironment,
  CollaborationTranslate,
  SharedWorkspaceApi,
} from '@wegent/collaboration'
import { GroupExecutionDevices } from './GroupExecutionDevices'

const translate: CollaborationTranslate = (_key, fallback) => fallback ?? _key
function fixture(canManage = true) {
  const own = {
    id: 'own',
    device_id: 7,
    device_key: 'physical',
    name: 'My offline device',
    owner_type: 'user',
    owner_id: '9',
    status: 'offline',
    kind: 'local_device',
  } as CollaborationExecutionEnvironment
  const foreign = {
    ...own,
    id: 'foreign',
    device_id: 8,
    owner_id: '10',
    name: 'Other private device',
  }
  const local = vi.fn(async () => [own])
  const cloud = vi.fn(async () => [own, foreign])
  const add = vi.fn(async () => own)
  const remove = vi.fn(async () => undefined)
  const list = vi.fn(async () => [])
  const api = {
    projects: {
      listExecutionEnvironments: list,
      addExecutionEnvironment: add,
      removeExecutionEnvironment: remove,
    },
    resources: { devices: { local, cloud } },
  } as unknown as SharedWorkspaceApi
  render(
    <GroupExecutionDevices
      api={api}
      groupId="group"
      store="cloud"
      currentUserId={9}
      canManage={canManage}
      translate={translate}
    />
  )
  return { add, remove, list, cloud }
}

describe('Group execution device consent', () => {
  it('explicitly grants an owned offline device and preserves the row on failed revocation', async () => {
    const { cloud, add, remove } = fixture()
    const user = userEvent.setup()
    await waitFor(() =>
      expect(screen.queryByTestId('group-execution-device-loading')).not.toBeInTheDocument()
    )
    expect(cloud).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('group-execution-device-add'))
    await screen.findByText('My offline device')
    expect(screen.queryByText('Other private device')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('group-execution-device-candidate-7'))
    await waitFor(() => expect(add).toHaveBeenCalledWith('group', 7))
    await screen.findByTestId('group-execution-device-7')
    expect(screen.queryByTestId('group-execution-device-initialize-7')).not.toBeInTheDocument()
    expect(screen.getByTestId('group-execution-device-7')).not.toHaveAttribute(
      'data-preparation-state'
    )
    remove.mockRejectedValueOnce(new Error('Permission revoked'))
    await user.click(screen.getByTestId('group-execution-device-remove-7'))
    await screen.findByRole('alert')
    expect(screen.getByTestId('group-execution-device-7')).toBeInTheDocument()
    await user.click(screen.getByTestId('group-execution-device-remove-7'))
    await waitFor(() =>
      expect(screen.queryByTestId('group-execution-device-7')).not.toBeInTheDocument()
    )
  })

  it('does not fetch private candidates for a non-administrator', async () => {
    const { list, cloud, add } = fixture(false)
    await waitFor(() => expect(list).toHaveBeenCalledWith('group'))
    expect(screen.queryByTestId('group-execution-device-add')).not.toBeInTheDocument()
    expect(cloud).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
  })
})
