// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, expectTypeOf, it } from 'vitest'

import type {
  SharedWorkspaceApi,
  SharedWorkspaceHostPort,
  WebWorkspaceHostPort,
  WeworkWorkspaceRuntimePort,
} from './SharedWorkspaceApi'

describe('SharedWorkspaceApi boundaries', () => {
  it('keeps every cloud capability in one domain-shaped API', () => {
    expectTypeOf<keyof SharedWorkspaceApi>().toEqualTypeOf<
      | 'projects'
      | 'issues'
      | 'comments'
      | 'attachments'
      | 'collaborators'
      | 'taskBindings'
      | 'workflowPlans'
      | 'members'
      | 'files'
      | 'deliveries'
      | 'executions'
      | 'automations'
      | 'incomingHooks'
      | 'runtimeProfiles'
      | 'agents'
    >()

    const domains = [
      'projects',
      'issues',
      'comments',
      'attachments',
      'collaborators',
      'taskBindings',
      'workflowPlans',
      'members',
      'files',
      'deliveries',
      'executions',
      'automations',
      'incomingHooks',
      'runtimeProfiles',
      'agents',
    ]
    expect(new Set(domains).size).toBe(domains.length)
  })

  it('does not leak desktop runtime methods into the cloud API', () => {
    expectTypeOf<SharedWorkspaceApi>().not.toHaveProperty('trackProjectTask')
    expectTypeOf<SharedWorkspaceApi>().not.toHaveProperty('claimNextExecution')
    expectTypeOf<WeworkWorkspaceRuntimePort>().toHaveProperty('trackProjectTask')
    expectTypeOf<WeworkWorkspaceRuntimePort>().toHaveProperty('claimNextExecution')
  })

  it('keeps host effects outside the cloud API', () => {
    expectTypeOf<SharedWorkspaceApi>().not.toHaveProperty('navigate')
    expectTypeOf<WebWorkspaceHostPort>().toHaveProperty('navigate')
    expectTypeOf<SharedWorkspaceHostPort>().toHaveProperty('saveFile')
  })
})
