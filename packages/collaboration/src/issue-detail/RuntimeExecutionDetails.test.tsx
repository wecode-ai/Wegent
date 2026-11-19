// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import { CollaborationTheme } from '../theme'
import {
  RuntimeExecutionDetails,
  type RuntimeExecutionDetailsProps,
} from './RuntimeExecutionDetails'

let container: HTMLDivElement
let root: Root
const translate = createCollaborationTranslator('zh-CN')

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
function element(id: string) {
  const target = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  if (!target) throw new Error(`Missing control ${id}`)
  return target
}
function renderDetails(props: Partial<RuntimeExecutionDetailsProps> = {}) {
  act(() =>
    root.render(
      <CollaborationTheme mode="dark">
        <RuntimeExecutionDetails
          senderName="Agent"
          taskTitle="Implement quicksort"
          runId="run-7"
          modelName="current-model"
          deviceName="Cloud device"
          runStatus="running"
          onRetryTranscript={vi.fn()}
          onClose={vi.fn()}
          translate={translate}
          {...props}
        >
          <div data-testid="actual-conversation">Conversation content</div>
        </RuntimeExecutionDetails>
      </CollaborationTheme>
    )
  )
}

describe('runtime execution details without a desktop host', () => {
  it('preserves a successful run while showing the actual transcript read failure', () => {
    renderDetails({
      runStatus: 'completed',
      transcriptUnavailable: true,
      transcriptError: "Device 'original-cloud' is offline",
    })
    expect(element('runtime-execution-detail-status').textContent).toContain('执行成功')
    const error = element('runtime-execution-detail-transcript-error')
    expect(error.textContent).toContain('original-cloud')
    expect(error.textContent).not.toContain('执行器确认当前未运行')
  })
  it('never offers stop or claims ongoing execution when idle history is unavailable', () => {
    renderDetails({
      runStatus: 'unknown',
      executionRunning: false,
      transcriptUnavailable: true,
      onStop: vi.fn(),
    })
    expect(document.querySelector('[data-testid="runtime-execution-detail-stop"]')).toBeNull()
    expect(element('runtime-execution-detail-transcript-error').textContent).toContain(
      '执行器确认当前未运行'
    )
    expect(element('runtime-execution-detail-transcript-error').textContent).not.toContain(
      '任务仍在执行'
    )
  })

  it('preserves the scoped theme, full metadata and conversation content across the portal', () => {
    renderDetails()
    const overlay = element('runtime-execution-detail-overlay')
    expect(container.contains(overlay)).toBe(false)
    expect(overlay.dataset.theme).toBe('dark')
    expect(overlay.classList.contains('collaboration-theme')).toBe(true)
    expect(overlay.style.getPropertyValue('--color-background')).not.toBe('')
    expect(overlay.textContent).toContain('Cloud device')
    expect(overlay.textContent).toContain('current-model')
    expect(overlay.textContent).toContain('run-7')
    expect(element('runtime-execution-detail-body').contains(element('actual-conversation'))).toBe(
      true
    )
    expect(document.querySelector('[data-testid="runtime-execution-detail-open-page"]')).toBeNull()
    expect(document.querySelector('[data-testid="runtime-execution-detail-stop"]')).toBeNull()
  })

  it('keeps transcript failure separate from execution state and calls the real retry action', () => {
    const retry = vi.fn()
    const openTask = vi.fn()
    renderDetails({
      transcriptUnavailable: true,
      onRetryTranscript: retry,
      onOpenTask: openTask,
    })
    expect(element('runtime-execution-detail-status').textContent).toBe('执行中')
    expect(element('runtime-execution-detail-transcript-error').textContent).toContain(
      '暂时无法加载会话'
    )
    expect(document.querySelector('[data-testid="actual-conversation"]')).toBeNull()
    act(() => element('runtime-execution-detail-transcript-retry').click())
    act(() => element('runtime-execution-detail-open-page').click())
    expect(retry).toHaveBeenCalledOnce()
    expect(openTask).toHaveBeenCalledOnce()
  })

  it('disables duplicate stop requests and retains errors for retry', async () => {
    let rejectStop!: (cause: Error) => void
    const stop = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectStop = reject
        })
    )
    renderDetails({ onStop: stop })
    act(() => element('runtime-execution-detail-stop').click())
    expect((element('runtime-execution-detail-stop') as HTMLButtonElement).disabled).toBe(true)
    act(() => element('runtime-execution-detail-stop').click())
    expect(stop).toHaveBeenCalledOnce()
    await act(async () => rejectStop(new Error('device disconnected')))
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('device disconnected')
    expect((element('runtime-execution-detail-stop') as HTMLButtonElement).disabled).toBe(false)
    stop.mockResolvedValueOnce()
    await act(async () => element('runtime-execution-detail-stop').click())
    expect(stop).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[role="alert"]')).toBeNull()
    renderDetails({ runStatus: 'succeeded', onStop: stop })
    expect(document.querySelector('[data-testid="runtime-execution-detail-stop"]')).toBeNull()
  })

  it('focuses the close control and restores focus when dismissed', () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const close = vi.fn()
    renderDetails({ onClose: close })
    expect(document.activeElement).toBe(element('runtime-execution-detail-close'))
    act(() =>
      element('runtime-execution-detail-close').dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        })
      )
    )
    expect(close).toHaveBeenCalledOnce()
    act(() => root.render(null))
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })
  it('does not stop an execution twice within one event batch', async () => {
    const stop = vi.fn().mockResolvedValue(undefined)
    renderDetails({ onStop: stop })
    act(() => {
      element('runtime-execution-detail-stop').click()
      element('runtime-execution-detail-stop').click()
    })
    await act(async () => {})
    expect(stop).toHaveBeenCalledOnce()
  })

  it("does not retain a previous execution's stop request or late failure", async () => {
    let reject!: (cause: Error) => void
    const pending = new Promise<void>((_done, fail) => {
      reject = fail
    })
    renderDetails({ onStop: () => pending })
    act(() => element('runtime-execution-detail-stop').click())
    renderDetails({
      runId: 'next-run',
      onStop: vi.fn().mockResolvedValue(undefined),
    })
    expect((element('runtime-execution-detail-stop') as HTMLButtonElement).disabled).toBe(false)
    await act(async () => reject(new Error('old run disconnected')))
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('leaves Escape alone during input method composition', () => {
    const close = vi.fn()
    renderDetails({ onClose: close })
    act(() =>
      element('runtime-execution-detail-close').dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          isComposing: true,
          bubbles: true,
          cancelable: true,
        })
      )
    )
    expect(close).not.toHaveBeenCalled()
  })

  it('contains Tab inside the execution dialog', () => {
    renderDetails()
    const first = element('runtime-execution-detail-close')
    const last = element('runtime-execution-detail-footer-close')
    last.focus()
    const forward = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    })
    act(() => last.dispatchEvent(forward))
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)
    const backward = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    act(() => first.dispatchEvent(backward))
    expect(document.activeElement).toBe(last)
  })

  it('restores the original opener after switching execution records', () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    try {
      opener.focus()
      renderDetails()
      renderDetails({ runId: 'another-run' })
      expect(document.activeElement).toBe(element('runtime-execution-detail-close'))
      act(() => root.render(null))
      expect(document.activeElement).toBe(opener)
    } finally {
      opener.remove()
    }
  })
  it('leaves Escape to an open native child dialog', () => {
    const close = vi.fn()
    renderDetails({ onClose: close })
    const child = document.createElement('dialog')
    child.open = true
    const childButton = document.createElement('button')
    child.append(childButton)
    element('runtime-execution-detail-overlay').append(child)
    try {
      childButton.focus()
      act(() =>
        childButton.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          })
        )
      )
      expect(close).not.toHaveBeenCalled()
    } finally {
      child.remove()
    }
  })
})
