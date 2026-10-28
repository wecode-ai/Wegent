// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { listGroups } from '@/apis/groups'
import { fetchUnifiedSkillsList } from '@/apis/skills'
import SkillManagementModal from '@/features/settings/components/skills/SkillManagementModal'

const mockToast = jest.fn()
const mockT = (key: string) => key

jest.mock('@/apis/skills', () => ({
  fetchUnifiedSkillsList: jest.fn(),
  fetchPublicSkillsList: jest.fn(),
}))

jest.mock('@/apis/groups', () => ({
  listGroups: jest.fn(),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: mockT,
  }),
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

jest.mock('@/features/resource-library/components/MarketplaceTagsDialog', () => ({
  MarketplaceTagsDialog: () => null,
}))

jest.mock('@/features/settings/components/skills/SkillReferenceConflictDialog', () => ({
  SkillReferenceConflictDialog: () => null,
}))

jest.mock('@/features/settings/components/skills/SkillUploadModal', () => ({
  __esModule: true,
  default: ({
    writableGroups,
    createTarget,
    publishAfterCreate,
    namespace,
    writableGroupsError,
    onCreateOptionsChange,
    onRetryWritableGroups,
  }: {
    writableGroups: Array<{ name: string }>
    createTarget: { scope: string; groupName?: string; groupNames?: string[] }
    publishAfterCreate?: boolean
    namespace?: string
    writableGroupsError: Error | null
    onCreateOptionsChange: (
      target: { scope: string; groupName?: string; groupNames?: string[] },
      publishAfterCreate: boolean,
      marketplaceTags: string[]
    ) => void
    onRetryWritableGroups?: () => void
  }) => (
    <div data-testid="mock-skill-upload">
      <span data-testid="writable-groups">{writableGroups.map(group => group.name).join(',')}</span>
      <span data-testid="create-target">
        {createTarget.groupNames?.join(',') || createTarget.scope}
      </span>
      <span data-testid="upload-namespace">{namespace || ''}</span>
      <span data-testid="publish-after-create">{String(Boolean(publishAfterCreate))}</span>
      {writableGroupsError && (
        <span data-testid="writable-groups-error">{writableGroupsError.message}</span>
      )}
      <button
        type="button"
        data-testid="select-team"
        onClick={() =>
          onCreateOptionsChange(
            { scope: 'group', groupName: 'engineering', groupNames: ['engineering'] },
            false,
            []
          )
        }
      >
        select-team
      </button>
      <button
        type="button"
        data-testid="select-marketplace"
        onClick={() => onCreateOptionsChange({ scope: 'personal' }, true, [])}
      >
        select-marketplace
      </button>
      <button type="button" data-testid="retry-writable-groups" onClick={onRetryWritableGroups}>
        retry-groups
      </button>
    </div>
  ),
}))

describe('SkillManagementModal group publishing', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(fetchUnifiedSkillsList as jest.Mock).mockResolvedValue([])
    ;(listGroups as jest.Mock).mockResolvedValue({
      total: 2,
      items: [
        { id: 1, name: 'engineering', my_role: 'Developer' },
        { id: 2, name: 'readers', my_role: 'Reporter' },
      ],
    })
  })

  it('passes writable groups to the upload dialog and tracks the team target', async () => {
    render(<SkillManagementModal open onClose={jest.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: /common:skills\.upload_skill/ }))

    await waitFor(() => {
      expect(screen.getByTestId('writable-groups')).toHaveTextContent('engineering')
    })
    expect(screen.getByTestId('writable-groups')).not.toHaveTextContent('readers')

    fireEvent.click(screen.getByTestId('select-team'))

    expect(screen.getByTestId('create-target')).toHaveTextContent('engineering')
    expect(screen.getByTestId('upload-namespace')).toHaveTextContent('engineering')
  })

  it('keeps the upload in the personal namespace until a team is selected', async () => {
    render(<SkillManagementModal open onClose={jest.fn()} scope="group" groupName="rcdp" />)

    fireEvent.click(await screen.findByRole('button', { name: /common:skills\.upload_skill/ }))

    expect(await screen.findByTestId('upload-namespace')).toHaveTextContent('')
  })

  it('passes group-load errors and the retry action to the upload dialog', async () => {
    ;(listGroups as jest.Mock)
      .mockRejectedValueOnce(new Error('group load failed'))
      .mockResolvedValueOnce({
        total: 1,
        items: [{ id: 1, name: 'engineering', my_role: 'Developer' }],
      })

    render(<SkillManagementModal open onClose={jest.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: /common:skills\.upload_skill/ }))

    expect(await screen.findByTestId('writable-groups-error')).toHaveTextContent(
      'group load failed'
    )

    fireEvent.click(screen.getByTestId('retry-writable-groups'))

    await waitFor(() => {
      expect(screen.queryByTestId('writable-groups-error')).not.toBeInTheDocument()
    })
    expect(listGroups).toHaveBeenCalledTimes(2)
  })

  it('keeps the marketplace selection in the parent create options', async () => {
    render(<SkillManagementModal open onClose={jest.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: /common:skills\.upload_skill/ }))
    expect(screen.getByTestId('publish-after-create')).toHaveTextContent('false')

    fireEvent.click(screen.getByTestId('select-marketplace'))

    expect(screen.getByTestId('publish-after-create')).toHaveTextContent('true')
  })
})
