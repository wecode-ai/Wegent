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

import { regenerateControl } from '@/features/knowledge/code-wiki/CodeWikiReader'
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
    expect(control.hint).toBe('knowledge:codeWiki.reader.previousRunStalled')
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
})
