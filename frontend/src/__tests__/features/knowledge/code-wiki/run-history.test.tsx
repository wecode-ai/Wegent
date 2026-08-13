// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * The chip is the whole of the history a reader sees without clicking, so what it
 * says has to be right on its own. Most of all it must not report a wiki as fine
 * when its last run failed — that is the state this feature exists to surface, and
 * before it existed the reader got an empty page and no explanation.
 */

import { canRepublish, summarise } from '@/features/knowledge/code-wiki/RunHistory'
import { failureText } from '@/features/knowledge/code-wiki/failureText'
import { formatRelativeTime } from '@/utils/dateTime'
import type { CodeWikiRunStatus } from '@/types/code-wiki'

const t = (key: string, options?: Record<string, unknown>) =>
  options?.when ? `${key}:${options.when}` : key

function status(over: Partial<CodeWikiRunStatus>): CodeWikiRunStatus {
  return {
    status: 'completed',
    generation_id: 1,
    error_message: '',
    failure_code: '',
    is_stale: false,
    last_published_commit: '',
    ...over,
  }
}

describe('run history chip', () => {
  it('says a failed run failed rather than reporting the wiki as fine', () => {
    const chip = summarise(status({ status: 'failed', error_message: 'clone failed' }), t)

    expect(chip.label).toBe('codeWiki.history.lastFailed')
    expect(chip.tone).toBe('bad')
  })

  it('distinguishes a stalled run from a live one', () => {
    // Not cosmetic: the regenerate button beside it stays live for a stalled run, so
    // a chip still saying "generating" would contradict the only available action.
    expect(summarise(status({ status: 'running' }), t).tone).toBe('busy')
    expect(summarise(status({ status: 'running', is_stale: true }), t).tone).toBe('bad')
  })

  it('reports a wiki that has never run, including before the status arrives', () => {
    expect(summarise(status({ status: 'never' }), t).label).toBe('codeWiki.history.never')
    expect(summarise(null, t).label).toBe('codeWiki.history.never')
  })

  it('falls back to a plain label when there is no publish time to show', () => {
    // A completed run whose version was not published has no timestamp; interpolating
    // an empty one would render "Updated " with nothing after it.
    expect(summarise(status({ status: 'completed' }), t).label).toBe('codeWiki.history.completed')
  })
})

describe('relative time', () => {
  it('reads API timestamps as UTC', () => {
    // They arrive without a zone. Read as local they would sit in the future, and
    // every run generated in the last few hours would say "just now" forever.
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000)
      .toISOString()
      .replace('Z', '')
      .slice(0, 19)

    expect(formatRelativeTime(twoHoursAgo, t)).toBe('common:time.hours_ago')
  })

  it('says nothing for a run that has no timestamp', () => {
    expect(formatRelativeTime(null, t)).toBe('')
    expect(formatRelativeTime('not a date', t)).toBe('')
  })
})

describe('why a run failed', () => {
  it('translates a reason this server invented', () => {
    // It was shown verbatim: "The task ended as COMPLETED without reporting" sat
    // under a Chinese chip saying the run had failed, which reads as a bug rather
    // than as a diagnostic.
    expect(failureText('task_ended_without_report', '', t)).toBe(
      'codeWiki.failure.task_ended_without_report'
    )
  })

  it('passes external text through untouched', () => {
    // git's output, the agent's own message, an exception. There is nothing to
    // translate it into, and paraphrasing destroys the only detail there is.
    expect(failureText('', 'fatal: could not read Username', t)).toBe(
      'fatal: could not read Username'
    )
  })

  it('shows both when there is a code and a detail', () => {
    expect(failureText('task_not_created', 'no executor available', t)).toBe(
      'codeWiki.failure.task_not_created: no executor available'
    )
  })

  it('falls back to the text for a code it does not know', () => {
    // A server newer than this client must not blank the reason out.
    expect(failureText('invented_later', 'something happened', t)).toBe('something happened')
  })

  it('says nothing when there is nothing to say', () => {
    expect(failureText('', '', t)).toBe('')
  })
})

describe('going back to an earlier version', () => {
  it('is offered on a completed version that is not the live one', () => {
    // The gate is advisory now, so a run that went wrong does reach readers, and
    // everything it replaced is still in the version store. Before this there was no
    // way to any of it — the published pointer only moved forward.
    expect(canRepublish({ status: 'completed', published: false })).toBe(true)
  })

  it('is not offered on the version readers already see', () => {
    expect(canRepublish({ status: 'completed', published: true })).toBe(false)
  })

  it('is not offered on a run that produced no publishable result', () => {
    // A failed run may well have pages — they are the pages of a run that did not
    // succeed, and the server refuses them for the same reason.
    expect(canRepublish({ status: 'failed', published: false })).toBe(false)
    expect(canRepublish({ status: 'running', published: false })).toBe(false)
  })
})
