// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest'
import type { CollaborationIssue } from '../types'
import { bulkIssueStatus } from './bulkIssueStatus'

const issues = ['success', 'network', 'permission', 'runner', 'null'].map(
  id => ({ id }) as CollaborationIssue
)

describe('bulkIssueStatus', () => {
  it('reports every failed Issue after partial success, including null results', async () => {
    const update = vi.fn(async (issue: CollaborationIssue) => {
      if (issue.id === 'success') return issue
      if (issue.id === 'null') return null
      throw new Error(issue.id)
    })
    expect(
      await bulkIssueStatus(issues, update, error =>
        error instanceof Error ? error.message : 'Save failed'
      )
    ).toEqual(
      issues
        .slice(1)
        .map(issue => ({
          issueId: issue.id,
          message: issue.id === 'null' ? 'Save failed' : issue.id,
        }))
    )
    expect(update).toHaveBeenCalledTimes(5)
  })

  it('waits for outstanding mutations before returning failures', async () => {
    let finish!: (issue: CollaborationIssue) => void
    const update = vi.fn((issue: CollaborationIssue) =>
      issue.id === 'success'
        ? new Promise<CollaborationIssue>(resolve => {
            finish = resolve
          })
        : Promise.reject(new Error('Denied'))
    )
    const complete = vi.fn()
    const result = bulkIssueStatus(issues.slice(0, 2), update, () => 'Denied').then(complete)
    await Promise.resolve()
    expect(complete).not.toHaveBeenCalled()
    finish(issues[0])
    await result
    expect(complete).toHaveBeenCalledWith([{ issueId: 'network', message: 'Denied' }])
  })
})
