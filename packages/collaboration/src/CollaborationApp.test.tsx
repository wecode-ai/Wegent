// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ComponentProps } from 'react'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { CollaborationApp, collaborationProjectViewIds } from './CollaborationApp'
import type { SharedWorkspaceApi } from './ports/SharedWorkspaceApi'
import type { CollaborationLocation } from './types'

describe('CollaborationApp API boundary', () => {
  it('accepts the grouped SharedWorkspaceApi as its only cloud API', () => {
    expectTypeOf<
      ComponentProps<typeof CollaborationApp>['api']
    >().toEqualTypeOf<SharedWorkspaceApi>()
    expect(true).toBe(true)
  })

  it('models My Work as a root location rather than a project view', () => {
    const location: CollaborationLocation = {
      projectId: null,
      issueId: null,
      view: 'board',
      rootView: 'my-work',
    }

    expect(location.rootView).toBe('my-work')
  })

  it('uses the original Wework project view set without Web-only pages', () => {
    expect(collaborationProjectViewIds).toEqual(['board', 'files', 'automation', 'manage'])
    expect(collaborationProjectViewIds).not.toContain('members')
    expect(collaborationProjectViewIds).not.toContain('runs')
  })
})
