// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { KnowledgeAccessDialog } from '@/features/knowledge/document/components/KnowledgeAccessDialog'
import { registerAuthSection } from '@/features/knowledge/document/auth-section-registry'
import { knowledgePermissionApi } from '@/apis/knowledge-permission'
const mockT = (key: string) => key
jest.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: mockT }) }))
jest.mock('@/features/common/UserContext', () => ({ useUser: () => ({ user: { id: 1 } }) }))
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
  default: { getCacheScope: () => 'backend:session-1' },
}))
jest.mock('@/apis/groups', () => ({ searchGroups: jest.fn(async () => ({ items: [] })) }))
jest.mock('@/apis/knowledge-permission', () => ({
  knowledgePermissionApi: {
    getMyPermissionSources: jest.fn(async () => ({
      has_access: true,
      effective_role: 'Owner',
      is_creator: true,
      sources: [],
    })),
    listPermissions: jest.fn(async () => ({
      pending: [],
      approved: { Owner: [], Maintainer: [], Developer: [], Reporter: [], RestrictedAnalyst: [] },
    })),
    batchAddPermission: jest.fn(),
  },
}))

it('reuses registered selection, distinguishes equal ids, and retries only the failed grant', async () => {
  for (const type of ['test-a', 'test-b'])
    registerAuthSection({
      type,
      labelKey: type,
      renderSearch: ({ role, onSelect }) => (
        <button
          data-testid={'select-' + type}
          onClick={() => onSelect({ id: '7', entityType: type, entityId: '7', label: type, role })}
        >
          Select {type}
        </button>
      ),
    })
  const changed = jest.fn(),
    close = jest.fn()
  jest
    .mocked(knowledgePermissionApi.batchAddPermission)
    .mockResolvedValueOnce({
      succeeded: [],
      failed: [{ user_id: 0, entity_type: 'test-b', entity_id: '7', error: 'temporary failure' }],
    })
    .mockResolvedValueOnce({
      succeeded: [{ user_id: 0, entity_type: 'test-b', entity_id: '7', role: 'Reporter' }],
      failed: [],
    } as never)
  render(
    <KnowledgeAccessDialog
      resourceCreated
      kbId={29}
      kbNamespace="default"
      canManage
      onChanged={changed}
      onClose={close}
      onAccessLost={jest.fn()}
    />
  )
  expect(screen.getByRole('heading')).toHaveTextContent('document.creation.created')
  await userEvent.setup().click(await screen.findByTestId('permission-add-collaborator'))
  await userEvent.setup().click(screen.getByTestId('select-test-a'))
  await userEvent.setup().click(screen.getByTestId('select-test-b'))
  await userEvent.setup().click(screen.getByTestId('remove-auth-test-a-7'))
  expect(screen.getByTestId('remove-auth-test-b-7')).toBeInTheDocument()
  await userEvent.setup().click(screen.getByTestId('submit-created-permissions'))
  expect(await screen.findByText(/temporary failure/)).toBeInTheDocument()
  expect(screen.getByTestId('submit-created-permissions')).toHaveTextContent(
    'document.creation.retryFailed'
  )
  await userEvent.setup().click(screen.getByTestId('submit-created-permissions'))
  expect(await screen.findByText('document.creation.authorized')).toBeInTheDocument()
  expect(knowledgePermissionApi.batchAddPermission).toHaveBeenCalledTimes(2)
  expect(knowledgePermissionApi.batchAddPermission).toHaveBeenLastCalledWith(29, {
    members: [
      {
        user_id: 0,
        role: 'Reporter',
        entity_type: 'test-b',
        entity_id: '7',
        entity_display_name: 'test-b',
      },
    ],
  })
  await userEvent.setup().keyboard('{Escape}')
  await userEvent.setup().click(screen.getByTestId('finish-created-authorization'))
  expect(close).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(changed).toHaveBeenCalled())
})

it('rechecks access and leaves management after the first grant is authoritatively refused', async () => {
  const { ApiError } = await import('@/apis/client')
  registerAuthSection({
    type: 'forbidden-target',
    labelKey: 'forbidden-target',
    renderSearch: ({ role, onSelect }) => (
      <button
        data-testid="select-forbidden-target"
        onClick={() =>
          onSelect({
            id: 'target',
            entityType: 'forbidden-target',
            entityId: '7',
            role,
            label: 'Target',
          })
        }
      >
        Select target
      </button>
    ),
  })
  jest
    .mocked(knowledgePermissionApi.getMyPermissionSources)
    .mockReset()
    .mockResolvedValueOnce({
      has_access: true,
      effective_role: 'Owner',
      is_creator: true,
      sources: [],
    })
    .mockResolvedValueOnce({
      has_access: false,
      effective_role: 'Reporter',
      is_creator: false,
      sources: [],
    })
  jest
    .mocked(knowledgePermissionApi.batchAddPermission)
    .mockReset()
    .mockRejectedValueOnce(new ApiError('denied', 403))
  const lost = jest.fn(),
    close = jest.fn()
  render(
    <KnowledgeAccessDialog
      resourceCreated
      kbId={29}
      canManage
      onChanged={jest.fn()}
      onClose={close}
      onAccessLost={lost}
    />
  )
  await userEvent.setup().click(await screen.findByTestId('permission-add-collaborator'))
  await userEvent.setup().click(screen.getByTestId('select-forbidden-target'))
  await userEvent.setup().click(screen.getByTestId('submit-created-permissions'))
  await waitFor(() => expect(lost).toHaveBeenCalledTimes(1))
  expect(close).toHaveBeenCalledTimes(1)
  expect(screen.queryByTestId('perm-tab-user')).not.toBeInTheDocument()
})
