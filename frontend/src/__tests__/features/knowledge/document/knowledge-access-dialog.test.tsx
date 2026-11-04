// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { KnowledgeAccessDialog } from '@/features/knowledge/document/components/KnowledgeAccessDialog'
import { knowledgePermissionApi } from '@/apis/knowledge-permission'

let mockUser = { id: 1 }
let mockScope = 'backend:session-one'
const mockT = (key: string) => key
jest.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: mockT }) }))
jest.mock('@/features/common/UserContext', () => ({ useUser: () => ({ user: mockUser }) }))
jest.mock('@/apis/client', () => ({
  __esModule: true,
  ApiError: class extends Error {
    constructor(
      message: string,
      public status: number
    ) {
      super(message)
    }
  },
  default: { getCacheScope: () => mockScope },
}))
jest.mock('@/apis/knowledge-permission', () => ({
  knowledgePermissionApi: {
    getMyPermissionSources: jest.fn(),
    listPermissions: jest.fn(),
    updatePermission: jest.fn(),
    deletePermission: jest.fn(),
    reviewPermission: jest.fn(),
  },
}))

const reader = {
  has_access: true,
  effective_role: 'Reporter' as const,
  is_creator: false,
  sources: [
    {
      source_type: 'group_membership',
      display_name: 'Visible source team',
      role: 'Reporter' as const,
    },
  ],
}
const members = {
  pending: [],
  approved: { Owner: [], Maintainer: [], Developer: [], Reporter: [], RestrictedAnalyst: [] },
}
const props = () => ({
  kbId: 27,
  kbNamespace: 'space',
  canManage: false,
  onClose: jest.fn(),
  onChanged: jest.fn(),
  onAccessLost: jest.fn(),
})
beforeEach(() => {
  mockUser = { id: 1 }
  mockScope = 'backend:session-one'
  jest.clearAllMocks()
  jest.mocked(knowledgePermissionApi.getMyPermissionSources).mockReset()
  jest.mocked(knowledgePermissionApi.getMyPermissionSources).mockResolvedValue(reader)
  jest.mocked(knowledgePermissionApi.listPermissions).mockResolvedValue(members)
})

it('shows only my permission sources for a reader without loading the member list', async () => {
  render(<KnowledgeAccessDialog {...props()} />)
  expect(await screen.findByText('Visible source team')).toBeInTheDocument()
  expect(knowledgePermissionApi.listPermissions).not.toHaveBeenCalled()
  expect(screen.queryByTestId('perm-tab-user')).not.toBeInTheDocument()
})

it('reuses the existing manager and rechecks access after a successful permission change', async () => {
  const callbacks = props()
  jest.spyOn(window, 'confirm').mockReturnValue(true)
  jest
    .mocked(knowledgePermissionApi.getMyPermissionSources)
    .mockResolvedValueOnce({ ...reader, effective_role: 'Maintainer' })
  jest.mocked(knowledgePermissionApi.listPermissions).mockResolvedValue({
    ...members,
    approved: {
      ...members.approved,
      Reporter: [
        {
          id: 91,
          user_id: 6,
          display_name: 'Managed member',
          email: '',
          role: 'Reporter',
          requested_at: '2026-11-04T00:00:00Z',
        },
      ],
    },
  })
  jest.mocked(knowledgePermissionApi.deletePermission).mockResolvedValue({ message: 'ok' })
  render(<KnowledgeAccessDialog {...callbacks} canManage />)
  await screen.findByText('Managed member')
  await userEvent.setup().click(screen.getByTitle('document.permission.remove'))
  await waitFor(() => expect(callbacks.onChanged).toHaveBeenCalled())
  await waitFor(() => expect(screen.queryByTestId('perm-tab-user')).not.toBeInTheDocument())
  expect(knowledgePermissionApi.deletePermission).toHaveBeenCalledWith(27, 91)
  expect(knowledgePermissionApi.getMyPermissionSources).toHaveBeenCalledTimes(2)
})

it('retries a source error without reading members or treating an error as revoked access', async () => {
  const callbacks = props()
  jest
    .mocked(knowledgePermissionApi.getMyPermissionSources)
    .mockRejectedValueOnce(new Error('offline'))
  render(<KnowledgeAccessDialog {...callbacks} />)
  await screen.findByRole('alert')
  expect(callbacks.onAccessLost).not.toHaveBeenCalled()
  await userEvent.setup().click(screen.getByTestId('retry-permission-sources'))
  expect(await screen.findByText('Visible source team')).toBeInTheDocument()
  expect(knowledgePermissionApi.listPermissions).not.toHaveBeenCalled()
})

it('closes on confirmed access loss even when the underlying role is still a manager', async () => {
  const callbacks = props()
  jest
    .mocked(knowledgePermissionApi.getMyPermissionSources)
    .mockResolvedValueOnce({ ...reader, has_access: false, effective_role: 'Maintainer' })
  render(<KnowledgeAccessDialog {...callbacks} canManage />)
  await waitFor(() => expect(callbacks.onAccessLost).toHaveBeenCalledTimes(1))
  expect(callbacks.onClose).toHaveBeenCalledTimes(1)
  expect(knowledgePermissionApi.listPermissions).not.toHaveBeenCalled()
})

it.each(['user', 'backend', 'session', 'library'])(
  'ignores delayed source responses after %s changes',
  async kind => {
    let finish!: (value: typeof reader) => void
    jest.mocked(knowledgePermissionApi.getMyPermissionSources).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const callbacks = props()
    const { rerender } = render(<KnowledgeAccessDialog {...callbacks} />)
    if (kind === 'user') mockUser = { id: 2 }
    else if (kind !== 'library') mockScope = kind + ':next'
    jest.mocked(knowledgePermissionApi.getMyPermissionSources).mockResolvedValueOnce({
      ...reader,
      sources: [{ ...reader.sources[0], display_name: 'Current scope source' }],
    })
    rerender(<KnowledgeAccessDialog {...callbacks} kbId={kind === 'library' ? 28 : 27} />)
    expect(await screen.findByText('Current scope source')).toBeInTheDocument()
    await act(async () => finish(reader))
    expect(screen.queryByText('Visible source team')).not.toBeInTheDocument()
  }
)

it('unmounts management and its pending member response as soon as the parent confirms downgrade', async () => {
  let finish!: (value: typeof members) => void
  jest
    .mocked(knowledgePermissionApi.getMyPermissionSources)
    .mockResolvedValue({ ...reader, effective_role: 'Maintainer' })
  jest.mocked(knowledgePermissionApi.listPermissions).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const callbacks = props()
  const { rerender } = render(<KnowledgeAccessDialog {...callbacks} canManage />)
  await waitFor(() => expect(knowledgePermissionApi.listPermissions).toHaveBeenCalledTimes(1))
  rerender(<KnowledgeAccessDialog {...callbacks} canManage={false} />)
  await act(async () => finish(members))
  expect(screen.queryByTestId('perm-tab-user')).not.toBeInTheDocument()
})

it('restores keyboard focus to the surviving trigger on Escape', async () => {
  function Harness() {
    const [open, setOpen] = useState(false)
    return (
      <>
        <button data-testid="permission-open-focus" onClick={() => setOpen(true)}>
          Open permissions
        </button>
        {open && <KnowledgeAccessDialog {...props()} onClose={() => setOpen(false)} />}
      </>
    )
  }
  render(<Harness />)
  const trigger = screen.getByTestId('permission-open-focus')
  await userEvent.setup().click(trigger)
  await screen.findByText('Visible source team')
  await userEvent.setup().keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(trigger).toHaveFocus()
})

it('stops manager requests after a server denial even if raw source roles still look managerial', async () => {
  const { ApiError } = await import('@/apis/client')
  jest
    .mocked(knowledgePermissionApi.getMyPermissionSources)
    .mockResolvedValue({ ...reader, effective_role: 'Maintainer' })
  jest
    .mocked(knowledgePermissionApi.listPermissions)
    .mockReset()
    .mockRejectedValueOnce(new ApiError('denied', 403))
    .mockImplementation(() => new Promise(() => {}))
  render(<KnowledgeAccessDialog {...props()} canManage />)
  await waitFor(() =>
    expect(knowledgePermissionApi.getMyPermissionSources).toHaveBeenCalledTimes(2)
  )
  expect(knowledgePermissionApi.listPermissions).toHaveBeenCalledTimes(1)
  expect(screen.queryByTestId('perm-tab-user')).not.toBeInTheDocument()
})

it('retains registered extension tabs and forwards successful extension changes', async () => {
  const { registerPermissionTab } =
    await import('@/features/knowledge/permission/permission-tab-registry')
  registerPermissionTab({
    type: 'test-external',
    labelKey: 'test-extension-tab',
    label: 'Extension permissions',
    filter: () => false,
    renderAddButton: ({ onSuccess }) => (
      <button data-testid="test-extension-add" onClick={onSuccess}>
        Add extension permission
      </button>
    ),
  })
  jest
    .mocked(knowledgePermissionApi.getMyPermissionSources)
    .mockResolvedValue({ ...reader, effective_role: 'Maintainer' })
  jest.mocked(knowledgePermissionApi.listPermissions).mockResolvedValue(members)
  const callbacks = props()
  render(<KnowledgeAccessDialog {...callbacks} canManage />)
  await userEvent.setup().click(await screen.findByText('Extension permissions'))
  await userEvent.setup().click(screen.getByTestId('test-extension-add'))
  expect(callbacks.onChanged).toHaveBeenCalledTimes(1)
  await waitFor(() =>
    expect(knowledgePermissionApi.getMyPermissionSources).toHaveBeenCalledTimes(2)
  )
})

it('keeps an initial member error distinct from an empty member list and retries locally', async () => {
  jest
    .mocked(knowledgePermissionApi.getMyPermissionSources)
    .mockResolvedValue({ ...reader, effective_role: 'Maintainer' })
  jest
    .mocked(knowledgePermissionApi.listPermissions)
    .mockReset()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(members)
  render(<KnowledgeAccessDialog {...props()} canManage />)
  await screen.findByTestId('retry-knowledge-members')
  expect(screen.queryByText('document.permission.noPendingRequests')).not.toBeInTheDocument()
  await userEvent.setup().click(screen.getByTestId('retry-knowledge-members'))
  expect(await screen.findByTestId('perm-tab-user')).toBeInTheDocument()
})
