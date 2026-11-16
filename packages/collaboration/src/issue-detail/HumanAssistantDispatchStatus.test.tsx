// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import type { HumanAssistantDispatch } from '../types'
import { HumanAssistantDispatchStatus } from './HumanAssistantDispatchStatus'

const dispatch: HumanAssistantDispatch = {
  ownerUserId: 7,
  endpointRef: null,
  dispatchState: 'waiting_device',
  executionId: 42,
  reasonCode: 'device_offline',
  assignmentId: 'assignment-1',
  assignmentVersion: 1,
  createdAt: '2026-11-16T00:00:00Z',
  updatedAt: '2026-11-16T00:00:00Z',
}

describe('human assistant dispatch status', () => {
  it.each(['zh-CN', 'en'] as const)('shows explicit offline recovery in %s', locale => {
    const markup = renderToStaticMarkup(
      <HumanAssistantDispatchStatus
        itemId="issue-1"
        dispatch={dispatch}
        translate={createCollaborationTranslator(locale)}
      />
    )
    expect(markup).toContain('data-dispatch-state="waiting_device"')
    expect(markup).toContain(locale === 'en' ? 'Waiting for device' : '等待设备')
    expect(markup).toContain(locale === 'en' ? 'Processing resumes' : '连接恢复后继续处理')
    expect(markup).toContain('#42')
    expect(markup).not.toContain('human_assistant.state.')
  })

  it('does not imply a successful execution when authorization is missing', () => {
    const markup = renderToStaticMarkup(
      <HumanAssistantDispatchStatus
        itemId="issue-1"
        dispatch={{
          ...dispatch,
          dispatchState: 'no_authorized_assistant',
          executionId: null,
          reasonCode: 'no_authorized_assistant',
        }}
        translate={createCollaborationTranslator('en')}
        compact
      />
    )
    expect(markup).toContain('Authorization required')
    expect(markup).not.toContain('human-assistant-execution-')
    expect(markup).not.toContain('human-assistant-configure-')
  })

  it.each(['zh-CN', 'en'] as const)(
    'does not show an error for a successful execution in %s',
    locale => {
      const markup = renderToStaticMarkup(
        <HumanAssistantDispatchStatus
          itemId="issue-1"
          dispatch={{ ...dispatch, dispatchState: 'completed', reasonCode: 'runtime_succeeded' }}
          translate={createCollaborationTranslator(locale)}
        />
      )
      expect(markup).toContain(locale === 'en' ? 'Execution completed' : '执行已完成')
      expect(markup).not.toContain(locale === 'en' ? 'cannot continue' : '暂时无法继续处理')
      expect(markup).not.toContain('runtime_succeeded')
    }
  )

  it.each(['cancelling', 'cancelled'] as const)(
    'uses neutral recovery copy for %s runtime reasons',
    state => {
      const markup = renderToStaticMarkup(
        <HumanAssistantDispatchStatus
          itemId="issue-1"
          dispatch={{
            ...dispatch,
            dispatchState: state,
            reasonCode: 'runtime_cancel_acknowledged',
          }}
          translate={createCollaborationTranslator('en')}
        />
      )
      expect(markup).toContain(
        state === 'cancelling' ? 'dispatch is stopping' : 'dispatch has stopped'
      )
      expect(markup).not.toContain('cannot continue')
      expect(markup).not.toContain('runtime_cancel_acknowledged')
    }
  )

  it('uses the provided settings action without starting another execution', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    const root = createRoot(container)
    const configure = vi.fn()
    const openExecution = vi.fn()
    try {
      await act(async () =>
        root.render(
          <HumanAssistantDispatchStatus
            itemId="issue-1"
            dispatch={dispatch}
            translate={createCollaborationTranslator('en')}
            onConfigure={configure}
            onOpenExecution={openExecution}
          />
        )
      )
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('[data-testid="human-assistant-configure-issue-1"]')!
          .click()
      )
      expect(configure).toHaveBeenCalledOnce()
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('[data-testid="human-assistant-execution-issue-1"]')!
          .click()
      )
      expect(openExecution).toHaveBeenCalledOnce()
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('stays absent when the server does not enable assistant dispatch', () => {
    expect(
      renderToStaticMarkup(
        <HumanAssistantDispatchStatus
          itemId="issue-1"
          translate={createCollaborationTranslator('en')}
        />
      )
    ).toBe('')
  })
})
