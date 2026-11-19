// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { parseChangeRequest } from './environment'

describe('parseChangeRequest lifecycle fields', () => {
  it('normalizes GitHub checks, review, merge state, and head without exposing provider enums', () => {
    expect(
      parseChangeRequest('github', {
        number: 77,
        url: 'https://github.com/org/repo/pull/77',
        title: 'Lifecycle badge',
        state: 'OPEN',
        isDraft: false,
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'DIRTY',
        reviewDecision: 'REVIEW_REQUIRED',
        headRefOid: 'abc123',
        statusCheckRollup: { state: 'EXPECTED' },
      })
    ).toEqual({
      provider: 'github',
      number: 77,
      url: 'https://github.com/org/repo/pull/77',
      title: 'Lifecycle badge',
      state: 'open',
      draft: false,
      checks: 'pending',
      mergeability: 'conflicting',
      mergeStateStatus: 'dirty',
      reviewDecision: 'review_required',
      mergeQueue: 'unknown',
      headSha: 'abc123',
    })
  })

  it.each([
    ['CLEAN', 'clean'],
    ['BLOCKED', 'blocked'],
    ['BEHIND', 'behind'],
    ['UNSTABLE', 'unstable'],
    ['HAS_HOOKS', 'has_hooks'],
    ['DIRTY', 'dirty'],
    ['UNKNOWN', 'unknown'],
  ])('normalizes GitHub merge state %s', (input, expected) => {
    const parsed = parseChangeRequest('github', {
      number: 1,
      url: 'https://github.com/org/repo/pull/1',
      state: 'OPEN',
      mergeStateStatus: input,
    })

    expect(parsed?.mergeStateStatus).toBe(expected === 'unknown' ? undefined : expected)
  })

  it.each([
    ['APPROVED', 'approved'],
    ['CHANGES_REQUESTED', 'changes_requested'],
    ['REVIEW_REQUIRED', 'review_required'],
  ])('normalizes GitHub review decision %s', (input, expected) => {
    const parsed = parseChangeRequest('github', {
      number: 1,
      url: 'https://github.com/org/repo/pull/1',
      state: 'OPEN',
      reviewDecision: input,
    })

    expect(parsed?.reviewDecision).toBe(expected)
  })

  it('treats ERROR checks as a failure and GitLab commit ids as the head', () => {
    expect(
      parseChangeRequest('github', {
        number: 1,
        url: 'https://github.com/org/repo/pull/1',
        state: 'OPEN',
        statusCheckRollup: { state: 'ERROR' },
      })?.checks
    ).toBe('failure')
    expect(
      parseChangeRequest('gitlab', {
        iid: 2,
        web_url: 'https://gitlab.example.com/org/repo/-/merge_requests/2',
        state: 'opened',
        last_commit: { id: 'gitlab-head' },
      })?.headSha
    ).toBe('gitlab-head')
  })
})
