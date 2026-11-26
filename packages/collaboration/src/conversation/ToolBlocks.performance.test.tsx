// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import { ConversationTranslationProvider } from './ConversationTranslation'
import { AssistantMessage } from './AssistantMessage'
import * as presentation from './assistantMessagePresentation'
import { ToolBlocksDisplay } from './blocks/ToolBlocksDisplay'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import * as activity from './blocks/ProcessingActivity'
import * as labels from './blocks/toolBlockLabels'
import * as details from './blocks/ToolBlockDetails'
import * as duration from './blocks/processingDuration'
import type { ToolBlock } from './blocks/types'

let container: HTMLDivElement
let root: Root
const translate = createCollaborationTranslator('en')

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
      <ConversationTranslationProvider translate={translate}>
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
  it('keeps tool presentation stable while separate reasoning updates remain visible', () => {
    const project = vi.spyOn(presentation, 'getAssistantRenderProjection')
    const images = { identity: () => '', load: vi.fn(), download: vi.fn() }
    const command = tool()
    const thinking = {
      id: 'reasoning',
      subtaskId: 1,
      type: 'thinking' as const,
      content: 'Checking the workspace',
      status: 'streaming' as const,
      createdAt: Date.now(),
    }
    const update = (content: string, block = command) => {
      const message: WorkbenchMessage = {
        id: 'reply',
        role: 'assistant',
        status: 'streaming',
        content: '',
        createdAt: new Date().toISOString(),
        blocks: [block, { ...thinking, content }],
        runtimeDisplayItems: [
          { id: block.id, type: 'block' },
          { id: thinking.id, type: 'block' },
        ],
        streamingThinkingContent: content,
      }
      render(<AssistantMessage message={message} imageServices={images} devices={[]} />)
    }
    update(thinking.content)
    project.mockClear()

    update('Checking the workspace and tests')
    expect(project).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Checking the workspace and tests')
    expect(container.textContent).not.toContain('Searched code')

    update('Checking the workspace and tests', { ...command, toolInput: { command: 'ls' } })
    expect(project).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Searched code')
  })

  it('keeps completed tool history stable while answer text streams', () => {
    const classify = vi.spyOn(activity, 'countProcessingActivityKinds')
    const images = { identity: () => '', load: vi.fn(), download: vi.fn() }
    const command = tool()
    const update = (content: string, block = command) => {
      const message: WorkbenchMessage = {
        id: 'reply',
        role: 'assistant',
        status: 'streaming',
        content,
        createdAt: new Date().toISOString(),
        blocks: [block],
        runtimeDisplayItems: [
          { id: block.id, type: 'block' },
          { id: 'answer', type: 'assistant_text', content },
        ],
      }
      render(<AssistantMessage message={message} imageServices={images} devices={[]} />)
    }
    update('The workspace is ready')
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="processing-summary-toggle"]')!
        .click()
    )
    const detail = container.querySelector<HTMLButtonElement>('[data-tool-detail-toggle]')!
    act(() => detail.click())
    expect(container.textContent).toContain('result')
    classify.mockClear()

    update('The workspace is ready for review')

    expect(container.textContent).toContain('The workspace is ready for review')
    expect(classify).not.toHaveBeenCalled()
    expect(container.querySelector('[data-tool-detail-toggle]')).toBe(detail)

    update('The workspace is ready for review', {
      ...command,
      toolInput: { command: 'printf updated' },
      toolOutput: 'updated output',
    })
    expect(classify).toHaveBeenCalled()
    expect(container.textContent).toContain('printf updated')
    expect(container.querySelector('[data-testid="shell-tool-output"]')?.textContent).toContain(
      'updated output'
    )
  })

  it('follows a burst of tool rows with one layout read in the next frame', () => {
    const first = tool()
    const second = { ...first, id: 'second' }
    const third = { ...first, id: 'third' }
    render(<ToolBlocksDisplay blocks={[first]} isStreaming />)
    const viewport = container.querySelector<HTMLElement>(
      '[data-testid="processing-live-preview-scroll"]'
    )!
    const readHeight = vi.fn(() => 400)
    Object.defineProperty(viewport, 'scrollHeight', { get: readHeight })

    render(<ToolBlocksDisplay blocks={[first, second]} isStreaming />)
    render(<ToolBlocksDisplay blocks={[first, second, third]} isStreaming />)
    expect(readHeight).not.toHaveBeenCalled()

    act(() => vi.advanceTimersToNextFrame())
    expect(readHeight).toHaveBeenCalledTimes(1)
    expect(viewport.scrollTop).toBe(400)

    render(<ToolBlocksDisplay blocks={[first]} isStreaming />)
    render(null)
    act(() => vi.advanceTimersToNextFrame())
    expect(readHeight).toHaveBeenCalledTimes(1)
  })

  it('keeps completed tool rows stable while reasoning streams into the live preview', () => {
    const label = vi.spyOn(labels, 'getBlockLabel')
    const command = tool()
    const reasoning = {
      id: 'reasoning',
      subtaskId: 1,
      type: 'thinking' as const,
      content: 'Checking the workspace',
      status: 'streaming' as const,
      createdAt: Date.now(),
    }
    render(
      <ToolBlocksDisplay
        blocks={[command, reasoning]}
        isStreaming
        showInterToolThinking
        thinkingContent={reasoning.content}
      />
    )
    const preview = container.querySelector('[data-testid="processing-live-preview"]')
    const toggle = preview?.querySelector<HTMLButtonElement>('[data-tool-detail-toggle]')
    expect(toggle).toBeTruthy()
    act(() => toggle!.click())
    expect(preview?.textContent).toContain('result')
    label.mockClear()

    const nextReasoning = { ...reasoning, content: 'Checking the workspace and tests' }
    render(
      <ToolBlocksDisplay
        blocks={[command, nextReasoning]}
        isStreaming
        showInterToolThinking
        thinkingContent={nextReasoning.content}
      />
    )

    expect(label.mock.calls.filter(([block]) => block === command)).toHaveLength(0)
    expect(preview?.querySelector('[data-tool-detail-toggle]')).toBe(toggle)
    expect(preview?.textContent).toContain('result')
    expect(
      preview?.querySelector('[data-testid="tool-thinking-indicator"]')?.textContent
    ).toContain(nextReasoning.content)
  })

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
