// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ComponentProps } from 'react'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { CollaborationApp } from './CollaborationApp'
import type { SharedWorkspaceApi } from './ports/SharedWorkspaceApi'

describe('CollaborationApp API boundary', () => {
  it('accepts the grouped SharedWorkspaceApi as its only cloud API', () => {
    expectTypeOf<
      ComponentProps<typeof CollaborationApp>['api']
    >().toEqualTypeOf<SharedWorkspaceApi>()
    expect(true).toBe(true)
  })
})
