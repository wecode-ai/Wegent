// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PermissionManagementTab } from '@/features/knowledge/permission/components/PermissionManagementTab'
import { KnowledgeAuthorizationObjects } from '@/features/knowledge/permission/components/KnowledgeAuthorizationObjects'
import { KnowledgeBaseActions } from '@/features/knowledge/document/components/KnowledgeBaseActions'
import { KnowledgeAccessDialog } from '@/features/knowledge/document/components/KnowledgeAccessDialog'
import { knowledgePermissionApi } from '@/apis/knowledge-permission'

let mockUser = { id: 1 }
let mockScope = 'backend:session-one'
const mockT = (key: string, options?: Record<string, unknown>) =>
  options ? key + ' ' + Object.values(options).join(' ') : key
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
    batchAddPermission: jest.fn(),
    listPermissions: jest.fn(),
    updatePermission: jest.fn(),
    deletePermission: jest.fn(),
    reviewPermission: jest.fn(),
  },
}))

jest.mock('@/apis/groups', () => ({
  searchGroups: jest.fn(async () => ({
    items: [
      { id: 71, name: 'team-a', display_name: 'Team A' },
      { id: 72, name: 'team-b', display_name: 'Team B' },
    ],
  })),
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

it('shows approved authorization objects read-only without requesting approvals', async () => {
  render(<KnowledgeAccessDialog {...props()} />)
  expect(await screen.findByText('Visible source team')).toBeInTheDocument()
  await waitFor(() =>
    expect(knowledgePermissionApi.listPermissions).toHaveBeenCalledWith(27, {
      includePendingRequests: false,
    })
  )
  expect(screen.queryByTestId('permission-add-collaborator')).not.toBeInTheDocument()
  expect(screen.queryByTestId('permission-approve-1')).not.toBeInTheDocument()
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

it('retries a source error before loading approved members without treating an error as revoked access', async () => {
  const callbacks = props()
  jest
    .mocked(knowledgePermissionApi.getMyPermissionSources)
    .mockRejectedValueOnce(new Error('offline'))
  render(<KnowledgeAccessDialog {...callbacks} />)
  await screen.findByRole('alert')
  expect(knowledgePermissionApi.listPermissions).not.toHaveBeenCalled()
  expect(callbacks.onAccessLost).not.toHaveBeenCalled()
  await userEvent.setup().click(screen.getByTestId('retry-permission-sources'))
  expect(await screen.findByText('Visible source team')).toBeInTheDocument()
  await waitFor(() =>
    expect(knowledgePermissionApi.listPermissions).toHaveBeenCalledWith(27, {
      includePendingRequests: false,
    })
  )
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
  expect(knowledgePermissionApi.listPermissions).toHaveBeenCalledWith(27, {
    includePendingRequests: true,
  })
  await waitFor(() =>
    expect(knowledgePermissionApi.listPermissions).toHaveBeenLastCalledWith(27, {
      includePendingRequests: false,
    })
  )
  expect(screen.queryByTestId('permission-add-collaborator')).not.toBeInTheDocument()
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
  expect(await screen.findByTestId('knowledge-authorization-objects')).toBeInTheDocument()
})

it('keeps zero pending requests as a compact status without an empty approval section', async () => {
  jest
    .mocked(knowledgePermissionApi.getMyPermissionSources)
    .mockResolvedValue({ ...reader, effective_role: 'Maintainer' })
  render(<KnowledgeAccessDialog {...props()} canManage />)
  expect(await screen.findByTestId('knowledge-empty-pending')).toHaveTextContent(
    'document.permission.noPendingRequests'
  )
  expect(screen.queryByText('document.permission.pendingRequests')).not.toBeInTheDocument()
  expect(screen.getByTestId('knowledge-authorization-objects')).toBeInTheDocument()
})

it('keeps real pending requests actionable and compacts the section after approval', async () => {
  jest
    .mocked(knowledgePermissionApi.getMyPermissionSources)
    .mockResolvedValue({ ...reader, effective_role: 'Maintainer' })
  jest.mocked(knowledgePermissionApi.listPermissions).mockResolvedValueOnce({
    ...members,
    pending: [
      {
        id: 55,
        user_id: 6,
        username: 'Pending user',
        email: 'pending@example.invalid',
        role: 'Reporter',
        requested_at: '2026-11-04T00:00:00Z',
      },
    ],
  })
  jest.mocked(knowledgePermissionApi.reviewPermission).mockResolvedValue({
    id: 55,
    user_id: 6,
    role: 'Reporter',
    status: 'approved',
    reviewed_at: '2026-11-04T01:00:00Z',
    message: 'Approved',
  })
  render(<KnowledgeAccessDialog {...props()} canManage />)
  expect(await screen.findByTestId('permission-approve-55')).toBeEnabled()
  expect(screen.getByTestId('permission-reject-55')).toBeEnabled()
  expect(screen.queryByTestId('knowledge-empty-pending')).not.toBeInTheDocument()
  await userEvent.setup().click(screen.getByTestId('permission-approve-55'))
  expect(knowledgePermissionApi.reviewPermission).toHaveBeenCalledWith(27, 55, {
    action: 'approve',
    role: 'Reporter',
  })
  expect(await screen.findByTestId('knowledge-empty-pending')).toBeInTheDocument()
})

async function openGroupGrant(legacy = false) {
  const user = userEvent.setup()
  if (legacy) await user.click(await screen.findByTestId('perm-tab-namespace'))
  else await screen.findByTestId('permission-add-collaborator')
  await user.click(screen.getByTestId('permission-add-collaborator'))
  await user.click(screen.getByTestId('add-namespace-group-search'))
  await user.click(await screen.findByRole('button', { name: /Team A/ }))
  return user
}

it.each([false, true])(
  'notifies the outer permission session on group grants (partial=%s)',
  async partial => {
    const callbacks = props()
    jest
      .mocked(knowledgePermissionApi.getMyPermissionSources)
      .mockResolvedValue({ ...reader, effective_role: 'Maintainer' })
    jest.mocked(knowledgePermissionApi.batchAddPermission).mockResolvedValueOnce({
      succeeded: [{ entity_type: 'namespace', entity_id: '71', role: 'Reporter' }],
      failed: partial ? [{ entity_type: 'namespace', entity_id: '72', error: 'retry' }] : [],
    } as never)
    render(<KnowledgeAccessDialog {...callbacks} canManage />)
    const user = await openGroupGrant()
    if (partial) {
      await user.click(screen.getByTestId('add-namespace-group-search'))
      await user.click(await screen.findByRole('button', { name: /Team B/ }))
    }
    await user.click(screen.getByTestId('submit-created-permissions'))
    await waitFor(() => expect(callbacks.onChanged).toHaveBeenCalled())
    if (partial) {
      expect(screen.getByTestId('submit-created-permissions')).toBeInTheDocument()
      jest.mocked(knowledgePermissionApi.batchAddPermission).mockResolvedValueOnce({
        succeeded: [{ entity_type: 'namespace', entity_id: '72', role: 'Reporter' }],
        failed: [],
      } as never)
      await user.click(screen.getByTestId('submit-created-permissions'))
      expect(knowledgePermissionApi.batchAddPermission).toHaveBeenLastCalledWith(
        27,
        expect.objectContaining({ members: [expect.objectContaining({ entity_id: '72' })] })
      )
    }
  }
)

it.each([
  [403, true],
  [403, false],
  [404, true],
  [404, false],
] as const)(
  'rechecks reading access after a group grant is denied (%s, read=%s)',
  async (status, hasAccess) => {
    const callbacks = props()
    const { ApiError } = jest.requireMock('@/apis/client')
    jest
      .mocked(knowledgePermissionApi.getMyPermissionSources)
      .mockResolvedValueOnce({ ...reader, effective_role: 'Maintainer' })
      .mockResolvedValue({ ...reader, has_access: hasAccess })
    jest
      .mocked(knowledgePermissionApi.batchAddPermission)
      .mockRejectedValueOnce(new ApiError('denied', status))
    render(<KnowledgeAccessDialog {...callbacks} canManage />)
    const user = await openGroupGrant()
    await user.click(screen.getByTestId('submit-created-permissions'))
    await waitFor(() => expect(callbacks.onChanged).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.queryByTestId('permission-add-collaborator')).not.toBeInTheDocument()
    )
    if (hasAccess) {
      expect(callbacks.onAccessLost).not.toHaveBeenCalled()
      expect(callbacks.onClose).not.toHaveBeenCalled()
    } else {
      await waitFor(() => expect(callbacks.onAccessLost).toHaveBeenCalled())
      expect(callbacks.onClose).toHaveBeenCalled()
    }
  }
)

it('does not notify a new library session when an old group request finishes', async () => {
  const callbacks = props()
  jest
    .mocked(knowledgePermissionApi.getMyPermissionSources)
    .mockResolvedValue({ ...reader, effective_role: 'Maintainer' })
  let finish!: (value: unknown) => void
  jest.mocked(knowledgePermissionApi.batchAddPermission).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      }) as never
  )
  const { rerender } = render(<KnowledgeAccessDialog {...callbacks} canManage />)
  const user = await openGroupGrant()
  await user.click(screen.getByTestId('submit-created-permissions'))
  rerender(<KnowledgeAccessDialog {...callbacks} kbId={28} canManage />)
  await act(async () =>
    finish({
      succeeded: [{ entity_type: 'namespace', entity_id: '71', role: 'Reporter' }],
      failed: [],
    })
  )
  expect(callbacks.onChanged).not.toHaveBeenCalled()
})

it.each(['success', 'denied'])(
  'ignores late group notifications after the permission owner changes (%s)',
  async outcome => {
    let finish!: (value: unknown) => void
    let fail!: (reason: Error) => void
    const changed = jest.fn(),
      denied = jest.fn()
    jest.mocked(knowledgePermissionApi.batchAddPermission).mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finish = resolve
          fail = reject
        }) as never
    )
    const { rerender } = render(
      <PermissionManagementTab kbId={27} onChanged={changed} onAccessDenied={denied} />
    )
    const user = await openGroupGrant(true)
    await user.click(screen.getByTestId('submit-created-permissions'))
    rerender(<PermissionManagementTab kbId={28} onChanged={changed} onAccessDenied={denied} />)
    rerender(<PermissionManagementTab kbId={27} onChanged={changed} onAccessDenied={denied} />)
    await act(async () => {
      if (outcome === 'success')
        finish({
          succeeded: [{ entity_type: 'namespace', entity_id: '71', role: 'Reporter' }],
          failed: [],
        })
      else {
        const { ApiError } = jest.requireMock('@/apis/client')
        fail(new ApiError('denied', 403))
      }
    })
    expect(changed).not.toHaveBeenCalled()
    expect(denied).not.toHaveBeenCalled()
  }
)

it('returns to mobile More after closing the actual read-only permission dialog', async () => {
  function MobilePermission() {
    const [open, setOpen] = useState(false)
    return (
      <>
        <KnowledgeBaseActions mobile kbId={27} onPermissions={() => setOpen(true)} />
        {open && <KnowledgeAccessDialog {...props()} onClose={() => setOpen(false)} />}
      </>
    )
  }
  render(<MobilePermission />)
  const user = userEvent.setup()
  const more = screen.getByTestId('more-kb-27')
  await user.click(more)
  await user.click(screen.getByTestId('permission-kb-27'))
  await screen.findByText('Visible source team')
  await user.click(screen.getByTestId('close-knowledge-access'))
  await waitFor(() => expect(more).toHaveFocus())
})

it('shows the complete approved roster and rules read-only with stable same-name identities', async () => {
  jest
    .mocked(knowledgePermissionApi.listPermissions)
    .mockReset()
    .mockResolvedValue({
      ...members,
      creator: { user_id: 1, display_name: 'Library creator' },
      inherited_sources: [
        {
          source_type: 'group_membership',
          entity_type: 'namespace',
          entity_id: '71',
          display_name: 'Owning group',
          role: null,
        },
      ],
      approved: {
        ...members.approved,
        Reporter: Array.from({ length: 121 }, (_, index) => ({
          id: index + 1,
          user_id: index + 5,
          display_name: index < 2 ? 'Same name' : `Approved ${index}`,
          email: `approved-${index}@example.invalid`,
          role: 'Reporter' as const,
          requested_at: '2026-11-04T00:00:00Z',
        })),
      },
    })
  render(<KnowledgeAccessDialog {...props()} />)
  expect(await screen.findByText('Library creator')).toBeInTheDocument()
  expect(screen.getByText('Owning group')).toBeInTheDocument()
  expect(screen.getByText('Approved 120')).toBeInTheDocument()
  expect(screen.getAllByText('Same name')).toHaveLength(2)
  expect(screen.getByText('document.authorizationObjects.groupRole')).toBeInTheDocument()
  expect(screen.queryByTestId('permission-add-collaborator')).not.toBeInTheDocument()
  expect(screen.queryByTestId('knowledge-authorization-actions')).not.toBeInTheDocument()
  expect(screen.queryByTestId('knowledge-empty-pending')).not.toBeInTheDocument()
  expect(knowledgePermissionApi.listPermissions).toHaveBeenCalledWith(27, {
    includePendingRequests: false,
  })
  await userEvent.setup().type(screen.getByTestId('knowledge-member-search'), 'approved-120@')
  expect(screen.getByText('Approved 120')).toBeInTheDocument()
  expect(screen.queryByText('Approved 119')).not.toBeInTheDocument()
})

it('distinguishes same-name objects and controls by both entity type and stable identity', async () => {
  jest
    .mocked(knowledgePermissionApi.getMyPermissionSources)
    .mockResolvedValue({ ...reader, effective_role: 'Maintainer' })
  jest
    .mocked(knowledgePermissionApi.listPermissions)
    .mockReset()
    .mockResolvedValue({
      ...members,
      approved: {
        ...members.approved,
        Reporter: [
          ...[71, 72].map(id => ({
            id,
            user_id: null,
            display_name: 'Same organization',
            entity_type: 'namespace',
            entity_id: String(id),
            role: 'Reporter' as const,
            requested_at: '2026-11-04T00:00:00Z',
          })),
          {
            id: 73,
            user_id: 71,
            display_name: 'Same organization',
            entity_type: 'user',
            entity_id: '71',
            role: 'Reporter' as const,
            requested_at: '2026-11-04T00:00:00Z',
          },
        ],
      },
    })
  render(<KnowledgeAccessDialog {...props()} canManage />)
  await screen.findByTestId('knowledge-authorization-objects')
  expect(screen.getAllByText('document.authorizationObjects.identifier 71')).toHaveLength(2)
  expect(screen.getByText('document.authorizationObjects.identifier 72')).toBeInTheDocument()
  expect(screen.getAllByText('Same organization')).toHaveLength(3)
  expect(
    screen.getByRole('combobox', { name: /Same organization.*types.namespace.*71/ })
  ).toBeEnabled()
  expect(screen.getByRole('combobox', { name: /Same organization.*72/ })).toBeEnabled()
  expect(screen.getByRole('combobox', { name: /Same organization.*types.user.*71/ })).toBeEnabled()
  expect(
    screen.getByRole('button', { name: /removeObject.*Same organization.*types.user.*71/ })
  ).toBeEnabled()
  expect(
    screen.getByRole('button', { name: /removeObject.*Same organization.*types.namespace.*71/ })
  ).toBeEnabled()
  expect(screen.getByRole('button', { name: /removeObject.*Same organization.*72/ })).toBeEnabled()
})

it('defaults the public authorization-object view to read-only without loading approvals', async () => {
  render(<KnowledgeAuthorizationObjects kbId={27} onChanged={jest.fn()} />)
  await screen.findByTestId('knowledge-authorization-objects')
  expect(knowledgePermissionApi.listPermissions).toHaveBeenCalledWith(27, {
    includePendingRequests: false,
  })
  expect(screen.queryByTestId('permission-add-collaborator')).not.toBeInTheDocument()
  expect(screen.queryByTestId('knowledge-empty-pending')).not.toBeInTheDocument()
})

it('keeps a direct reader source and approved object visible even when their names match', async () => {
  jest.mocked(knowledgePermissionApi.getMyPermissionSources).mockResolvedValue({
    ...reader,
    sources: [{ source_type: 'direct', display_name: 'Direct reader', role: 'Reporter' }],
  })
  jest
    .mocked(knowledgePermissionApi.listPermissions)
    .mockReset()
    .mockResolvedValue({
      ...members,
      creator: { user_id: 1, display_name: 'Library creator' },
      approved: {
        ...members.approved,
        Reporter: [
          {
            id: 91,
            user_id: 6,
            display_name: 'Direct reader',
            role: 'Reporter',
            requested_at: '2026-11-04T00:00:00Z',
          },
        ],
      },
    })
  render(<KnowledgeAccessDialog {...props()} />)
  await screen.findByTestId('knowledge-authorization-objects')
  expect(screen.getAllByText('Direct reader')).toHaveLength(2)
  expect(
    within(screen.getByTestId('knowledge-permission-sources')).getByText('Direct reader')
  ).toBeVisible()
  expect(
    within(screen.getByTestId('knowledge-authorization-objects')).getByText('Direct reader')
  ).toBeVisible()
  expect(screen.getAllByTestId('collaborator-item')).toHaveLength(2)
})
