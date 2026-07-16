// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React from 'react'
import { renderHook } from '@testing-library/react'
import { useTeamEditExtension } from '@/features/tasks/hooks/useTeamEditExtension'

describe('useTeamEditExtension', () => {
  it('does not create the edit dialog while it is closed', () => {
    const createDialogComponent = jest.fn(() => <div data-testid="team-edit-dialog" />)

    const { result } = renderHook(() =>
      useTeamEditExtension({
        currentTeamId: 1,
        currentTeamNamespace: 'default',
        userId: 1,
        deps: {
          getGroupRoleMap: () => new Map(),
          checkCanEdit: () => true,
          fetchBots: jest.fn(),
          createDialogComponent,
        },
        onTeamUpdated: jest.fn(),
      })
    )

    expect(result.current?.renderDialog()).toBeNull()
    expect(createDialogComponent).not.toHaveBeenCalled()
  })
})
