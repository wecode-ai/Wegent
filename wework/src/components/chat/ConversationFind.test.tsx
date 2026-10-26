import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import { AssistantMarkdown } from '@wegent/collaboration/markdown'
import {
  getConversationDiagnosticsSnapshot,
  resetConversationDiagnosticsForTest,
} from '@wegent/collaboration/conversation/conversationDiagnostics'
import {
  conversationSearchRanges,
  useConversationSearchTarget,
} from '../../../../packages/collaboration/src/conversation/useConversationSearchTarget'
import { ContentFindBar } from '@/components/common/ContentFindBar'
import { conversationSearchText, findConversationMatches } from './conversationSearch'
import { useConversationFind } from './useConversationFind'
import { ConversationFindBar } from './ConversationFindBar'
import '@/i18n'

vi.mock('@/lib/platform', () => ({ getPlatform: () => 'mac' }))

function message(
  id: string,
  content: string,
  role: WorkbenchMessage['role'] = 'assistant'
): WorkbenchMessage {
  return { id, content, role, status: 'done', createdAt: '2026-10-14T00:00:00Z' }
}

function FindHarness({
  active = true,
  ...props
}: Parameters<typeof useConversationFind>[0] & { active?: boolean }) {
  return <ConversationFindBar find={useConversationFind(props, active)} />
}

afterEach(() => {
  resetConversationDiagnosticsForTest()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('conversation find', () => {
  test('indexes visible Markdown prose and code, without hidden context, link URLs, tools or attachments', () => {
    const user = message(
      'user',
      '<application_context>private-context</application_context>\n输出 **代码**',
      'user'
    )
    const assistant = message(
      'assistant',
      '[输出](https://hidden.example)\n\n```ts\nconst output = 1\n```\n\n![private-image](image.png)'
    )
    assistant.blocks = [
      {
        id: 'tool',
        subtaskId: 'turn',
        type: 'tool',
        toolName: 'bash',
        toolOutput: 'private-tool',
        status: 'done',
        createdAt: 0,
      },
    ]
    const index = [user, assistant].map(item => ({
      messageId: item.id,
      text: conversationSearchText(item),
    }))
    expect(findConversationMatches(index, '输出')).toEqual({
      matches: [
        { messageId: 'user', occurrence: 0, regionId: 'user', range: { start: 0, end: 2 } },
        {
          messageId: 'assistant',
          occurrence: 0,
          regionId: 'assistant',
          range: { start: 0, end: 2 },
        },
      ],
      totalMatches: 2,
      isCapped: false,
    })
    expect(findConversationMatches(index, 'OUTPUT')).toEqual({
      matches: [
        {
          messageId: 'assistant',
          occurrence: 0,
          regionId: 'assistant',
          range: { start: 9, end: 15 },
        },
      ],
      totalMatches: 1,
      isCapped: false,
    })
    for (const query of [
      'private-context',
      'hidden.example',
      'private-tool',
      'private-image',
      '```ts',
      '   ',
    ]) {
      expect(findConversationMatches(index, query)).toEqual({
        matches: [],
        totalMatches: 0,
        isCapped: false,
      })
    }
    expect(conversationSearchText(user)).toBe('输出 代码')
  })

  test('counts every occurrence while keeping the first 250 navigable matches in message order', () => {
    const result = findConversationMatches(
      [
        { messageId: 'first', text: '灰度 '.repeat(200) },
        { messageId: 'second', text: '灰度 '.repeat(100) },
      ],
      '灰'
    )
    expect(result.totalMatches).toBe(300)
    expect(result.isCapped).toBe(true)
    expect(result.matches).toHaveLength(250)
    expect(result.matches[0]).toEqual({
      messageId: 'first',
      occurrence: 0,
      regionId: 'first',
      range: { start: 0, end: 1 },
    })
    expect(result.matches[199]).toEqual({
      messageId: 'first',
      occurrence: 199,
      regionId: 'first',
      range: { start: 597, end: 598 },
    })
    expect(result.matches[200]).toEqual({
      messageId: 'second',
      occurrence: 0,
      regionId: 'second',
      range: { start: 0, end: 1 },
    })
    expect(result.matches[249]).toEqual({
      messageId: 'second',
      occurrence: 49,
      regionId: 'second',
      range: { start: 147, end: 148 },
    })
  })

  test('indexes displayed assistant text in timeline order and hides failure and citation metadata', () => {
    const assistant = message('assistant', 'first\n\nlast')
    assistant.blocks = [
      {
        id: 'middle',
        subtaskId: 'turn',
        type: 'text',
        content: 'middle',
        status: 'done',
        createdAt: 0,
      },
    ]
    assistant.runtimeDisplayItems = [
      { type: 'assistant_text', id: 'first', content: 'first' },
      { type: 'block', id: 'middle' },
      { type: 'assistant_text', id: 'last', content: 'last' },
    ]
    expect(conversationSearchText(assistant)).toBe('first\nmiddle\nlast')
    expect(
      conversationSearchText({
        ...assistant,
        content: 'Error: private',
        error: 'private',
        status: 'failed',
        blocks: [],
        runtimeDisplayItems: [],
      })
    ).toBe('')
    expect(
      conversationSearchText(message('citation', '正文\uE200cite\uE202private-citation\uE201'))
    ).toBe('正文')
    expect(
      conversationSearchText(message('reply', 'answer', 'user'), [
        { question: '问题', answer: '**answer**' },
      ])
    ).toBe('问题\n**answer**')
  })

  test('matches across formatting and code spans while excluding controls and paragraph boundaries', () => {
    const container = document.createElement('article')
    container.innerHTML =
      '<div data-testid="assistant-message-content"><p>输<strong>出</strong></p><p>foo</p><p>bar</p><pre><code><span>out</span><span>put</span></code></pre><button>输出</button></div>'
    expect(conversationSearchRanges(container, '输出', 250).map(range => range.toString())).toEqual(
      ['输出']
    )
    expect(
      conversationSearchRanges(container, 'OUTPUT', 250).map(range => range.toString())
    ).toEqual(['output'])
    expect(conversationSearchRanges(container, 'foobar', 250)).toEqual([])
  })

  test('matches rendered Markdown link labels in index order without generated line suffixes or controls', () => {
    const source =
      '输出 [**输出** report.ts](src/report.ts:18) [输出 internal](/projects/search/settings/environment-variables) [输出 external](https://example.invalid/report)'
    const index = [{ messageId: 'links', text: conversationSearchText(message('links', source)) }]
    const { container } = render(
      <article>
        <div data-testid="assistant-message-content">
          <AssistantMarkdown content={source} />
          <button type="button">输出</button>
          <span aria-hidden="true">输出</span>
        </div>
      </article>
    )
    const links = screen.getAllByTestId('assistant-markdown-link')
    expect(links.map(link => link.tagName)).toEqual(['BUTTON', 'BUTTON', 'A'])
    expect(screen.getByTestId('assistant-markdown-link-line')).toHaveTextContent('(line 18)')
    const indexed = findConversationMatches(index, '输出')
    const ranges = conversationSearchRanges(container, '输出', 250)
    expect(indexed.matches.map(match => match.occurrence)).toEqual([0, 1, 2, 3])
    expect(ranges.map(range => range.toString())).toEqual(Array(indexed.totalMatches).fill('输出'))
    for (let linkIndex = 0; linkIndex < links.length; linkIndex += 1) {
      expect(links[linkIndex].contains(ranges[linkIndex + 1].startContainer)).toBe(true)
    }
    expect(
      conversationSearchRanges(container, '输出 report.ts', 250).map(range => range.toString())
    ).toEqual(['输出 report.ts'])
    for (const query of ['line 18', 'src/report.ts', 'example.invalid']) {
      expect(findConversationMatches(index, query).totalMatches).toBe(0)
      expect(conversationSearchRanges(container, query, 250)).toEqual([])
    }
  })

  test('jumps to an offscreen diagram source and keeps that position while the viewer loads', async () => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    vi.spyOn(window, 'matchMedia').mockReturnValue({ ...preference, matches: true })
    let onResize!: ResizeObserverCallback
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          onResize = callback
        }
        observe() {}
        disconnect() {}
      }
    )
    const scroller = document.createElement('div')
    scroller.scrollTop = 900
    Object.defineProperties(scroller, {
      scrollHeight: { value: 4_000 },
      clientHeight: { value: 300 },
    })
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 600, 300))
    scroller.scrollTo = vi.fn()
    const content = document.createElement('div')
    content.innerHTML =
      '<article data-message-id="target"><div data-testid="assistant-message-content"><p>Long message</p><section><span hidden data-diagram-search-source>graph LR\nA[输出] --&gt; B</span></section></div></article>'
    const diagram = content.querySelector('section')!
    vi.spyOn(diagram, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 1_600, 600, 384))
    expect(conversationSearchRanges(content, '输出', 1).map(range => range.toString())).toEqual([
      '输出',
    ])
    renderHook(() =>
      useConversationSearchTarget({
        target: {
          query: '输出',
          messageId: 'target',
          occurrence: 0,
          matchCounts: new Map([['target', 1]]),
        },
        contentRef: { current: content },
        scrollRef: { current: scroller },
        onNavigationTargetChange: vi.fn(),
      })
    )
    await waitFor(() =>
      expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 2_442, behavior: 'auto' })
    )
    const scrollCount = vi.mocked(scroller.scrollTo).mock.calls.length
    await act(async () => {
      diagram.replaceChildren()
      await new Promise(resolve => setTimeout(resolve, 100))
      onResize([], {} as ResizeObserver)
    })
    expect(scroller.scrollTo).toHaveBeenCalledTimes(scrollCount)
  })

  test('maps repeated code matches without repeatedly inspecting preceding text nodes', () => {
    const container = document.createElement('article')
    container.innerHTML = `<div data-testid="assistant-message-content"><pre><code>${'<span>关</span><span>键</span><span>词</span><span>甲</span> '.repeat(
      40
    )}</code></pre></div>`
    const lengthReads = vi.spyOn(CharacterData.prototype, 'length', 'get')
    for (const query of ['关键词甲', '关键词', '关']) {
      const ranges = conversationSearchRanges(container, query, 250)
      expect(ranges).toHaveLength(40)
      expect(ranges.map(range => range.toString())).toEqual(Array(40).fill(query))
    }
    expect(lengthReads.mock.calls.length).toBeLessThanOrEqual(600)
    expect(conversationSearchRanges(container, '关', 3).map(range => range.toString())).toEqual([
      '关',
      '关',
      '关',
    ])
    expect(conversationSearchRanges(container, '关', 0)).toEqual([])
  })

  test('shares the highlight budget across all text sources within a message', () => {
    const container = document.createElement('article')
    container.innerHTML =
      '<div data-testid="process-text-block"><p>输出 输出</p></div><div data-testid="assistant-message-content"><p>输出 输出</p></div>'
    const sources = container.querySelectorAll('p')
    const ranges = conversationSearchRanges(container, '输出', 3)
    expect(ranges.map(range => range.toString())).toEqual(['输出', '输出', '输出'])
    expect(sources[0].contains(ranges[0].startContainer)).toBe(true)
    expect(sources[0].contains(ranges[1].startContainer)).toBe(true)
    expect(sources[1].contains(ranges[2].startContainer)).toBe(true)
  })

  test('Cmd+F opens only the active pane and wraps forward and backward by occurrence', async () => {
    const props = {
      messages: [message('first', '输出 输出'), message('last', '输出')],
      active: false,
    }
    const { result, rerender } = renderHook(
      ({ active, ...props }) => useConversationFind(props, active),
      { initialProps: props }
    )
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
    })
    expect(result.current.open).toBe(false)
    rerender({ ...props, active: true })
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      result.current.changeQuery('输出')
    })
    await waitFor(() =>
      expect(result.current.result).toEqual({ matches: 3, active: 1, isCapped: false })
    )
    act(() => result.current.step(-1))
    expect(result.current.searchTarget?.messageId).toBe('last')
    act(() => result.current.step(1))
    expect(result.current.searchTarget).toEqual({
      query: '输出',
      messageId: 'first',
      occurrence: 0,
      regionId: 'first',
      range: { start: 0, end: 2 },
      matchCounts: new Map([
        ['first', 2],
        ['last', 1],
      ]),
    })
    act(() => result.current.changeQuery('missing'))
    expect(result.current.result).toEqual({ matches: 3, active: 1, isCapped: false })
    expect(result.current.searchTarget).toEqual({
      query: '输出',
      messageId: 'first',
      occurrence: 0,
      regionId: 'first',
      range: { start: 0, end: 2 },
      matchCounts: new Map([
        ['first', 2],
        ['last', 1],
      ]),
    })
    await waitFor(() => expect(result.current.searchTarget).toBeNull())
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(result.current.open).toBe(false)
  })

  test('Enter requests navigation again when the query has a single result', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const messages = [message('first', '输出')]
    const { result } = renderHook(() => useConversationFind({ messages }, true))
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      result.current.changeQuery('输出')
    })
    act(() => vi.advanceTimersByTime(150))
    const previousTarget = result.current.searchTarget
    expect(previousTarget?.messageId).toBe('first')
    act(() => result.current.submit(1))
    expect(result.current.searchTarget).toEqual(previousTarget)
    expect(result.current.searchTarget).not.toBe(previousTarget)
    expect(result.current.result).toEqual({ matches: 1, active: 1, isCapped: false })
  })

  test('replaces the search icon while input is debounced, completes on Enter, and clears immediately', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    render(<FindHarness messages={[message('first', '灰度 灰度 输出')]} />)
    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    const input = screen.getByTestId('conversation-find-input')
    const loadingIcon = () => screen.queryByTestId('conversation-find-loading-icon')
    expect(loadingIcon()).not.toBeInTheDocument()

    fireEvent.change(input, { target: { value: '灰度' } })
    expect(input).toHaveAttribute('aria-busy', 'true')
    expect(loadingIcon()).toBeInTheDocument()
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('0')
    act(() => vi.advanceTimersByTime(149))
    expect(loadingIcon()).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(loadingIcon()).not.toBeInTheDocument()
    expect(input).not.toHaveAttribute('aria-busy')
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 2')

    fireEvent.change(input, { target: { value: '输出' } })
    fireEvent.change(input, { target: { value: '灰度' } })
    expect(loadingIcon()).toBeInTheDocument()
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 2')
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(loadingIcon()).toBeInTheDocument()
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('2 / 2')
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 2')
    act(() => vi.advanceTimersByTime(150))
    expect(loadingIcon()).not.toBeInTheDocument()
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 2')

    fireEvent.change(input, { target: { value: '输出' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(loadingIcon()).not.toBeInTheDocument()
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 1')

    fireEvent.change(input, { target: { value: '灰度' } })
    expect(loadingIcon()).toBeInTheDocument()
    fireEvent.change(input, { target: { value: '' } })
    expect(loadingIcon()).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(150))
    expect(screen.getByTestId('conversation-find-count')).toBeEmptyDOMElement()

    fireEvent.change(input, { target: { value: '输出' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    act(() => vi.advanceTimersByTime(150))
    expect(screen.queryByTestId('conversation-find-bar')).not.toBeInTheDocument()
  })

  test('deleting a character keeps the current result and updates without flashing zero or resetting to the first', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    render(<FindHarness messages={[message('first', '灰度 灰度 灰度 灰度 灰')]} />)
    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    const input = screen.getByTestId('conversation-find-input')
    const count = screen.getByTestId('conversation-find-count')
    fireEvent.change(input, { target: { value: '灰度' } })
    act(() => vi.advanceTimersByTime(150))
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(count).toHaveTextContent('3 / 4')

    fireEvent.change(input, { target: { value: '灰' } })
    expect(input).toHaveValue('灰')
    expect(input).toHaveAttribute('aria-busy', 'true')
    expect(count).toHaveTextContent('3 / 4')
    act(() => vi.advanceTimersByTime(149))
    expect(count).toHaveTextContent('3 / 4')
    act(() => vi.advanceTimersByTime(1))
    expect(input).not.toHaveAttribute('aria-busy')
    expect(count).toHaveTextContent('3 / 5')
  })

  test('correlates consecutive Backspace input, commits and frames without recording private text', async () => {
    const user = userEvent.setup()
    const query = 'PrivateKeyword'
    const transcript = 'Private transcript content'
    render(<FindHarness messages={[message('private-message-id', `${query} ${transcript}`)]} />)
    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    const input = screen.getByTestId('conversation-find-input')
    await act(() => new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())))
    await user.type(input, query)
    expect(input).toHaveValue(query)
    await waitFor(() => expect(input).not.toHaveAttribute('aria-busy'))
    resetConversationDiagnosticsForTest()

    await user.keyboard('{Backspace}{Backspace}{Backspace}')
    expect(input).toHaveValue(query.slice(0, -3))
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByTestId('conversation-find-bar')).not.toBeInTheDocument()
    await act(() => new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())))

    const snapshot = getConversationDiagnosticsSnapshot()!
    const sequences = [query.length + 1, query.length + 2, query.length + 3]
    for (const name of [
      'search-delete',
      'search-input',
      'search-commit',
      'search-frame',
    ] as const) {
      const events = snapshot.events.filter(event => event.name === name)
      expect(events).toHaveLength(3)
      expect(events.map(event => event.details.inputSequence)).toEqual(sequences)
      expect(events.map(event => event.details.queryLength)).toEqual(
        name === 'search-delete'
          ? [query.length, query.length - 1, query.length - 2]
          : [query.length - 1, query.length - 2, query.length - 3]
      )
      for (const event of events) {
        expect(Number.isFinite(event.elapsedMs)).toBe(true)
        expect(event.elapsedMs).toBeGreaterThanOrEqual(0)
        const timingKey =
          name === 'search-commit' || name === 'search-frame' ? 'elapsedMs' : 'eventDelayMs'
        expect(Number.isFinite(event.details[timingKey])).toBe(true)
      }
    }
    expect(
      snapshot.events.every(event =>
        Object.values(event.details).every(value => typeof value !== 'string')
      )
    ).toBe(true)
    expect(JSON.stringify(snapshot)).not.toMatch(/Private|private-message-id/)
  })

  test('preserves a legal result index after typing and resets only when the new result has fewer occurrences', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { result } = renderHook(() =>
      useConversationFind({ messages: [message('first', '灰度 灰度 灰度 灰度 输出')] }, true)
    )
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      result.current.changeQuery('灰度')
    })
    act(() => vi.advanceTimersByTime(150))
    act(() => result.current.step(1))
    act(() => result.current.step(1))
    expect(result.current.result.active).toBe(3)
    act(() => result.current.changeQuery('灰'))
    act(() => vi.advanceTimersByTime(150))
    expect(result.current.result).toEqual({ matches: 4, active: 3, isCapped: false })
    act(() => result.current.changeQuery('输出'))
    expect(result.current.result).toEqual({ matches: 4, active: 3, isCapped: false })
    act(() => vi.advanceTimersByTime(150))
    expect(result.current.result).toEqual({ matches: 1, active: 1, isCapped: false })
  })

  test('counts capped results while navigation wraps across only the 250 retained matches', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { result } = renderHook(() =>
      useConversationFind({ messages: [message('first', '灰 '.repeat(251))] }, true)
    )
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      result.current.changeQuery('灰')
    })
    act(() => vi.advanceTimersByTime(150))
    expect(result.current.result).toEqual({ matches: 251, active: 1, isCapped: true })
    expect(result.current.searchTarget?.matchCounts).toEqual(new Map([['first', 250]]))
    act(() => result.current.step(-1))
    expect(result.current.result).toEqual({ matches: 251, active: 250, isCapped: true })
    expect(result.current.searchTarget?.occurrence).toBe(249)
    act(() => result.current.step(1))
    expect(result.current.result.active).toBe(1)
    expect(result.current.searchTarget?.occurrence).toBe(0)
  })

  test('arrow navigation keeps the completed query while Enter submits the pending query from its first result', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { result } = renderHook(() =>
      useConversationFind({ messages: [message('first', '灰度 灰度 输出 输出 输出')] }, true)
    )
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      result.current.changeQuery('灰度')
    })
    act(() => vi.advanceTimersByTime(150))
    act(() => result.current.changeQuery('输出'))
    act(() => result.current.step(1))
    expect(result.current.query).toBe('输出')
    expect(result.current.isLoading).toBe(true)
    expect(result.current.result).toEqual({ matches: 2, active: 2, isCapped: false })
    expect(result.current.searchTarget?.query).toBe('灰度')
    act(() => result.current.submit(-1))
    expect(result.current.isLoading).toBe(false)
    expect(result.current.result).toEqual({ matches: 3, active: 1, isCapped: false })
    expect(result.current.searchTarget?.query).toBe('输出')
    act(() => vi.advanceTimersByTime(150))
    expect(result.current.result.active).toBe(1)
  })

  test('closing clears the query and reopening starts an empty search', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    render(<FindHarness messages={[message('first', '灰度 输出')]} />)
    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    const input = screen.getByTestId('conversation-find-input')
    fireEvent.change(input, { target: { value: '灰度' } })
    act(() => vi.advanceTimersByTime(150))
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 1')
    fireEvent.change(input, { target: { value: '输出' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    act(() => vi.advanceTimersByTime(150))
    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    expect(screen.getByTestId('conversation-find-input')).toHaveValue('')
    expect(screen.getByTestId('conversation-find-count')).toBeEmptyDOMElement()
    expect(screen.queryByTestId('conversation-find-loading-icon')).not.toBeInTheDocument()
  })

  test('resets results and pending query when switching conversations without remounting the hook', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const props = {
      conversationKey: 'find-a',
      messages: [message('first', '灰度 灰度 输出')],
    }
    const { result, rerender } = renderHook(props => useConversationFind(props, true), {
      initialProps: props,
    })
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      result.current.changeQuery('灰度')
    })
    act(() => vi.advanceTimersByTime(150))
    act(() => result.current.step(1))
    expect(result.current.result.active).toBe(2)
    act(() => result.current.changeQuery('输出'))
    expect(result.current.isLoading).toBe(true)

    rerender({ conversationKey: 'find-b', messages: [message('second', '输出')] })
    expect(result.current.open).toBe(false)
    expect(result.current.query).toBe('')
    expect(result.current.searchTarget).toBeNull()
    expect(result.current.isLoading).toBe(false)
    act(() => vi.advanceTimersByTime(150))
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      result.current.changeQuery('输出')
    })
    act(() => vi.advanceTimersByTime(150))
    expect(result.current.result).toEqual({ matches: 1, active: 1, isCapped: false })
    expect(result.current.searchTarget?.messageId).toBe('second')
  })

  test('clears completed targets and cancels pending search when the pane becomes inactive', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const props = { messages: [message('first', '灰度 输出')], active: true }
    const { result, rerender } = renderHook(
      ({ active, ...props }) => useConversationFind(props, active),
      { initialProps: props }
    )
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      result.current.changeQuery('灰度')
    })
    act(() => vi.advanceTimersByTime(150))
    expect(result.current.searchTarget?.query).toBe('灰度')
    act(() => result.current.changeQuery('   '))
    expect(result.current.searchTarget).toBeNull()
    expect(result.current.isLoading).toBe(false)
    act(() => result.current.changeQuery('输出'))
    expect(result.current.searchTarget).toBeNull()
    expect(result.current.isLoading).toBe(true)
    rerender({ ...props, active: false })
    act(() => vi.advanceTimersByTime(150))
    expect(result.current.isLoading).toBe(false)
    rerender(props)
    expect(result.current.isLoading).toBe(true)
    act(() => vi.advanceTimersByTime(150))
    expect(result.current.searchTarget).toEqual({
      query: '输出',
      messageId: 'first',
      occurrence: 0,
      regionId: 'first',
      range: { start: 3, end: 5 },
      matchCounts: new Map([['first', 1]]),
    })
    expect(result.current.isLoading).toBe(false)
  })

  test('find input preserves IME composition, supports Enter/Shift+Enter, and refocuses on repeated Cmd+F', async () => {
    const step = vi.fn(),
      enter = vi.fn(),
      close = vi.fn()
    const props = {
      query: '输出',
      result: { matches: 2, active: 1, isCapped: false },
      unavailable: false,
      inputLabel: 'Find in chat',
      placeholder: 'Search chat',
      testIdPrefix: 'conversation-find',
      focusRequest: 0,
      onQueryChange: vi.fn(),
      onStep: step,
      onEnter: enter,
      onClose: close,
    }
    const { rerender } = render(<ContentFindBar {...props} />)
    const input = screen.getByTestId('conversation-find-input')
    await waitFor(() => expect(input).toHaveFocus())
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(step).not.toHaveBeenCalled()
    expect(enter).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(enter.mock.calls).toEqual([[1], [-1]])
    expect(step).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('conversation-find-next-button'))
    fireEvent.click(screen.getByTestId('conversation-find-prev-button'))
    expect(step.mock.calls).toEqual([[1], [-1]])
    expect(enter.mock.calls).toEqual([[1], [-1]])
    screen.getByTestId('conversation-find-close-button').focus()
    rerender(
      <ContentFindBar
        {...props}
        result={{ matches: 300, active: 250, isCapped: true }}
        focusRequest={1}
      />
    )
    await waitFor(() => expect(input).toHaveFocus())
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('250 / 300+')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
  })
})
