// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * The regenerate control used to be disabled only while its own request was in
 * flight, so reloading the page during a run made a busy wiki look idle and the next
 * click came back as an unexplained conflict.
 *
 * These pin the four states, and most of all that a stalled run stays actionable:
 * the server reclaims it before starting the next one, so reporting the wiki as busy
 * would leave the reader waiting for a worker that is already gone.
 */

import { emptyStateText, regenerateControl } from '@/features/knowledge/code-wiki/CodeWikiReader'
import type { CodeWikiRunStatus } from '@/types/code-wiki'

const t = (key: string) => key

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

describe('regenerate control state', () => {
  it('is unavailable while a run is going', () => {
    const control = regenerateControl(status({ status: 'running' }), false, t)

    expect(control.disabled).toBe(true)
    expect(control.busy).toBe(true)
  })

  it('is available again once the run has stalled', () => {
    const control = regenerateControl(status({ status: 'running', is_stale: true }), false, t)

    expect(control.disabled).toBe(false)
    expect(control.hint).toBe('codeWiki.reader.previousRunStalled')
  })

  it('shows why the last run failed', () => {
    const control = regenerateControl(
      status({ status: 'failed', error_message: 'container gone' }),
      false,
      t
    )

    expect(control.disabled).toBe(false)
    expect(control.hint).toBe('container gone')
  })

  it('stays usable when the status cannot be read', () => {
    // Otherwise a failure unrelated to the wiki would leave the reader unable to act.
    const control = regenerateControl(null, false, t)

    expect(control.disabled).toBe(false)
  })

  it('is unavailable while its own request is in flight', () => {
    const control = regenerateControl(status({ status: 'completed' }), true, t)

    expect(control.disabled).toBe(true)
  })

  it('offers to generate, not regenerate, when nothing was ever published', () => {
    // The state a failed first run leaves behind, where this button is the way out.
    const control = regenerateControl(status({ status: 'failed' }), false, t)

    expect(control.label).toBe('codeWiki.reader.generateFirst')
  })

  it('offers to regenerate once there is a published version', () => {
    const control = regenerateControl(
      status({ status: 'completed', last_published_at: '2026-08-01T00:00:00Z' }),
      false,
      t
    )

    expect(control.label).toBe('codeWiki.reader.regenerate')
  })
})

describe('what an empty reader says', () => {
  it('says it is working rather than asking for a run that is already going', () => {
    // Generation starts by itself at creation, so this is the first thing a creator
    // sees. Telling them to generate one asks for what is already happening.
    const empty = emptyStateText(status({ status: 'running' }), t)

    expect(empty.title).toBe('codeWiki.reader.emptyGenerating')
    expect(empty.hint).toBe('codeWiki.reader.emptyGeneratingHint')
  })

  it('says the last run did not finish when it failed', () => {
    const empty = emptyStateText(status({ status: 'failed' }), t)

    expect(empty.title).toBe('codeWiki.reader.emptyFailed')
  })

  it('treats a stalled run as a failure rather than as work in progress', () => {
    // Its worker is gone, so "being generated" would leave the reader waiting for
    // something that will never finish.
    const empty = emptyStateText(status({ status: 'running', is_stale: true }), t)

    expect(empty.title).toBe('codeWiki.reader.emptyFailed')
  })

  it('falls back to the plain empty text when nothing has been attempted', () => {
    const empty = emptyStateText(status({ status: 'never' }), t)

    expect(empty.title).toBe('codeWiki.reader.empty')
  })
})
