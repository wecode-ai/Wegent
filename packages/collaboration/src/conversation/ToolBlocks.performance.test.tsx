// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import { ConversationTranslationProvider } from './ConversationTranslation'
import { ToolBlocksDisplay } from './blocks/ToolBlocksDisplay'
import * as activity from './blocks/ProcessingActivity'
import * as labels from './blocks/toolBlockLabels'
import * as details from './blocks/ToolBlockDetails'
import * as duration from './blocks/processingDuration'
import type { ToolBlock } from './blocks/types'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-04T15:41:00Z'))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function render(children: ReactNode) {
  act(() =>
    root.render(
      <ConversationTranslationProvider translate={createCollaborationTranslator('en')}>
        {children}
      </ConversationTranslationProvider>
    )
  )
}

function advance(ms: number) {
  // Separate ticks reproduce browser tasks instead of batching an entire second into one render.
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    act(() => vi.advanceTimersByTime(100))
  }
}

function tool(status: ToolBlock['status'] = 'done'): ToolBlock {
  return {
    id: 'command',
    subtaskId: 1,
    type: 'tool',
    toolName: 'bash',
    toolInput: { command: 'sh -lc "printf result"' },
    toolOutput: 'result',
    status,
    createdAt: Date.now() - 5000,
    ...(status === 'done' ? { completedAt: Date.now() } : {}),
  }
}

describe('processing clock render isolation', () => {
  it('does no clock work for the hidden summary duration while waiting after a tool', () => {
    const classify = vi.spyOn(activity, 'countProcessingActivityKinds')
    const format = vi.spyOn(duration, 'getDurationText')
    render(<ToolBlocksDisplay blocks={[tool()]} isStreaming />)
    classify.mockClear()
    format.mockClear()

    advance(1000)

    expect({
      classifications: classify.mock.calls.length,
      durations: format.mock.calls.length,
    }).toEqual({ classifications: 0, durations: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('updates tenths on a running tool without rebuilding its label, stats or expanded output', () => {
    const label = vi.spyOn(labels, 'getBlockLabel')
    const classify = vi.spyOn(activity, 'countProcessingActivityKinds')
    const detail = vi.spyOn(details, 'renderBlockDetail')
    const block = tool('streaming')
    render(<ToolBlocksDisplay blocks={[block]} isStreaming forceExpanded />)
    const toggle = container.querySelector<HTMLButtonElement>('[data-tool-detail-toggle]')!
    act(() => toggle.click())
    expect(container.textContent).toContain('result')
    const initial = container.querySelector('[data-testid="tool-block-duration"]')!.textContent
    label.mockClear()
    classify.mockClear()
    detail.mockClear()

    advance(100)
    expect(container.querySelector('[data-testid="tool-block-duration"]')!.textContent).not.toBe(
      initial
    )
    advance(900)

    expect({
      labels: label.mock.calls.length,
      classifications: classify.mock.calls.length,
      details: detail.mock.calls.length,
    }).toEqual({ labels: 0, classifications: 0, details: 0 })

    render(
      <ToolBlocksDisplay
        blocks={[{ ...block, status: 'done' }]}
        isStreaming={false}
        forceExpanded
      />
    )
    const completed = container.querySelector('[data-testid="tool-block-duration"]')!.textContent
    advance(1000)
    expect(container.querySelector('[data-testid="tool-block-duration"]')!.textContent).toBe(
      completed
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('still renders new tool input and output after isolating the clock', () => {
    const block = tool('streaming')
    render(<ToolBlocksDisplay blocks={[block]} isStreaming forceExpanded />)
    act(() => container.querySelector<HTMLButtonElement>('[data-tool-detail-toggle]')!.click())
    advance(1000)

    render(
      <ToolBlocksDisplay
        blocks={[
          {
            ...block,
            toolInput: { command: 'printf updated' },
            toolOutput: 'updated output',
          },
        ]}
        isStreaming
        forceExpanded
      />
    )

    expect(container.textContent).toContain('printf updated')
    expect(container.querySelector('[data-testid="shell-tool-output"]')?.textContent).toContain(
      'updated output'
    )
  })

  it('does not create a timer for an invisible thinking block', () => {
    render(
      <ToolBlocksDisplay
        blocks={[
          {
            id: 'thinking',
            subtaskId: 1,
            type: 'thinking',
            content: 'hidden reasoning',
            status: 'streaming',
            createdAt: Date.now(),
          },
        ]}
        isStreaming
        forceExpanded
        showSummary={false}
      />
    )

    expect(container.textContent).not.toContain('hidden reasoning')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a visible thinking summary clock live, freezes on completion and cleans up', () => {
    const format = vi.spyOn(duration, 'getDurationText')
    const block = {
      id: 'thinking',
      subtaskId: 1,
      type: 'thinking' as const,
      content: 'reasoning',
      status: 'streaming' as const,
      createdAt: Date.now() - 5000,
    }
    render(<ToolBlocksDisplay blocks={[block]} startedAt={block.createdAt} isStreaming />)
    const summary = () =>
      container.querySelector('[data-testid="processing-summary-header"]')!.textContent
    const initial = summary()
    format.mockClear()
    advance(1000)
    expect(summary()).not.toBe(initial)
    expect(format).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)

    render(
      <ToolBlocksDisplay
        blocks={[{ ...block, status: 'done' }]}
        startedAt={block.createdAt}
        isStreaming={false}
      />
    )
    const completed = summary()
    advance(2000)
    expect(summary()).toBe(completed)
    expect(vi.getTimerCount()).toBe(0)

    render(<ToolBlocksDisplay blocks={[block]} startedAt={block.createdAt} isStreaming />)
    const resumed = summary()
    advance(1000)
    expect(summary()).not.toBe(resumed)
    render(null)
    expect(vi.getTimerCount()).toBe(0)
  })
})
