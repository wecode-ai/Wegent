// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import type { DirectHumanAssignmentReceipt } from '../types'
import { DirectHumanAssignmentReceiptStatus } from './DirectHumanAssignmentReceiptStatus'

const receipt: DirectHumanAssignmentReceipt = {
  projectId: 'project-1',
  issueId: 'issue-1',
  humanAssignmentId: 'human-1',
  dispatchId: 'dispatch-1',
  ownerUserId: 7,
  state: 'waiting_device',
  reasonCode: 'waiting_device',
  runtimeTaskId: null,
  deliveryId: null,
  updatedAt: '2026-11-16T00:00:00Z',
}

function markup(overrides: Partial<DirectHumanAssignmentReceipt>, locale: 'en' | 'zh-CN' = 'en') {
  return renderToStaticMarkup(
    <DirectHumanAssignmentReceiptStatus
      itemId="issue-1"
      receipt={{ ...receipt, ...overrides }}
      translate={createCollaborationTranslator(locale)}
    />
  )
}

describe('direct human assignment receipt status', () => {
  it.each(['zh-CN', 'en'] as const)('shows explicit device recovery in %s', locale => {
    const html = markup({}, locale)
    expect(html).toContain('data-receipt-state="waiting_device"')
    expect(html).toContain(locale === 'en' ? 'Waiting for device' : '等待设备')
    expect(html).toContain(locale === 'en' ? 'processing resumes' : '恢复连接后继续处理')
    expect(html).not.toContain('human_assignment_receipt.state.')
  })

  it.each([
    ['assistant_disabled', 'paused'],
    ['project_not_authorized', 'add this project'],
    ['automatic_disabled', 'enable automatic processing'],
    ['tag_mismatch', 'tag filters'],
    ['no_authorized_assistant', 'configure a default assistant'],
    ['permission_denied', 'project administrator'],
  ])('explains the actionable policy reason %s', (reasonCode, recovery) => {
    const html = markup({ state: 'blocked_policy', reasonCode })
    expect(html).toContain('Automatic acceptance blocked')
    expect(html).toContain(recovery)
    expect(html).not.toContain('Work completed')
  })

  it('shows permission denial without offering assistant configuration', () => {
    const html = renderToStaticMarkup(
      <DirectHumanAssignmentReceiptStatus
        itemId="issue-1"
        receipt={{ ...receipt, state: 'blocked_policy', reasonCode: 'permission_denied' }}
        translate={createCollaborationTranslator('en')}
        onConfigure={vi.fn()}
      />
    )
    expect(html).toContain('project administrator')
    expect(html).not.toContain('human-assistant-configure-')
  })

  it('explains unavailable device status without reporting acceptance', () => {
    const html = markup({ reasonCode: 'device_state_unavailable' })
    expect(html).toContain('device status is unavailable')
    expect(html).not.toContain('Accepted by assistant')
  })

  it('keeps notification-only work queued without treating an empty binding as failure', () => {
    const html = markup({ state: 'queued', reasonCode: null })
    expect(html).toContain('Awaiting acceptance')
    expect(html).not.toContain('Work failed')
    expect(html).not.toContain('human-assistant-execution-')
  })

  it('describes running as device acceptance rather than a notification receipt', () => {
    expect(markup({ state: 'running', reasonCode: null })).toContain('Accepted by assistant')
  })

  it.each(['zh-CN', 'en'] as const)('does not show an error after completion in %s', locale => {
    const html = markup({ state: 'completed', reasonCode: 'runtime_succeeded' }, locale)
    expect(html).toContain(locale === 'en' ? 'Work completed' : '处理已完成')
    expect(html).not.toContain(locale === 'en' ? 'cannot continue' : '暂时无法继续处理')
    expect(html).not.toContain('runtime_succeeded')
  })

  it.each(['cancelling', 'cancelled', 'superseded'] as const)(
    'uses neutral diagnostics for %s',
    state => {
      const html = markup({ state, reasonCode: 'runtime_cancel_acknowledged' })
      expect(html).not.toContain('cannot continue')
      expect(html).not.toContain('runtime_cancel_acknowledged')
      expect(html).toContain(
        state === 'cancelling'
          ? 'is stopping'
          : state === 'cancelled'
            ? 'was cancelled'
            : 'assignee has changed'
      )
    }
  )

  it('opens existing settings, owner conversation and an actual delivery through callbacks', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    const root = createRoot(container)
    const configure = vi.fn()
    const openTask = vi.fn()
    const openDelivery = vi.fn()
    try {
      await act(async () =>
        root.render(
          <DirectHumanAssignmentReceiptStatus
            itemId="issue-1"
            receipt={{ ...receipt, runtimeTaskId: 'private-task', deliveryId: 'delivery-1' }}
            translate={createCollaborationTranslator('en')}
            onConfigure={configure}
            onOpenTask={openTask}
            onOpenDelivery={openDelivery}
          />
        )
      )
      for (const action of ['configure', 'execution', 'delivery']) {
        await act(async () =>
          container
            .querySelector<HTMLButtonElement>(`[data-testid="human-assistant-${action}-issue-1"]`)!
            .click()
        )
      }
      expect(configure).toHaveBeenCalledOnce()
      expect(openTask).toHaveBeenCalledOnce()
      expect(openDelivery).toHaveBeenCalledOnce()
      expect(container.textContent).not.toContain('private-task')
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('does not show a stale receipt from another Issue', () => {
    expect(markup({ issueId: 'previous-issue' })).toBe('')
  })

  it('stays absent without the server feature projection', () => {
    expect(
      renderToStaticMarkup(
        <DirectHumanAssignmentReceiptStatus
          itemId="issue-1"
          translate={createCollaborationTranslator('en')}
        />
      )
    ).toBe('')
  })
})
