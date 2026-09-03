import { fireEvent } from '@testing-library/react'
import type { Terminal } from '@xterm/xterm'
import { describe, expect, test, vi } from 'vitest'
import { SELECTED_TEXT_CHANGED_EVENT, SELECTED_TEXT_DRAG_TYPE } from '@/lib/selected-text-drag'
import { installXtermTextDrag, readXtermBufferText, selectXtermBufferText } from './xtermTextDrag'

describe('xterm text drag', () => {
  test('creates draggable regions over the visible terminal selection', () => {
    const container = document.createElement('div')
    const screen = document.createElement('div')
    screen.className = 'xterm-screen'
    vi.spyOn(screen, 'getBoundingClientRect').mockReturnValue({
      bottom: 200,
      height: 200,
      left: 0,
      right: 800,
      top: 0,
      width: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    container.append(screen)
    let selectionHandler: (() => void) | null = null
    let selectedText = ''
    const disposable = () => ({ dispose: vi.fn() })
    const terminal = {
      buffer: {
        active: {
          viewportY: 0,
          length: 1,
          getLine: () => ({ translateToString: () => selectedText }),
        },
      },
      clearSelection: vi.fn(() => {
        selectedText = ''
        selectionHandler?.()
      }),
      cols: 80,
      focus: vi.fn(),
      getSelection: () => selectedText,
      getSelectionPosition: () =>
        selectedText
          ? {
              start: { x: 1, y: 1 },
              end: { x: 16, y: 1 },
            }
          : undefined,
      hasSelection: () => Boolean(selectedText),
      input: vi.fn(),
      onResize: vi.fn(disposable),
      onScroll: vi.fn(disposable),
      onSelectionChange: vi.fn((handler: () => void) => {
        selectionHandler = handler
        return disposable()
      }),
      rows: 20,
      select: vi.fn(),
    }
    const controller = installXtermTextDrag({ container, terminal })
    const selections: Array<{
      text: string | null
      rect: { left: number; top: number; width: number; height: number } | null
    }> = []
    const handleSelection = (event: Event) => {
      selections.push(
        (
          event as CustomEvent<{
            text: string | null
            rect: { left: number; top: number; width: number; height: number } | null
          }>
        ).detail
      )
    }
    window.addEventListener(SELECTED_TEXT_CHANGED_EVENT, handleSelection)

    selectedText = 'terminal output'
    selectionHandler?.()
    expect(selections.at(-1)).toEqual({
      source: expect.stringMatching(/^terminal:/),
      text: 'terminal output',
      rect: { left: 0, top: 0, width: 150, height: 10 },
    })
    const region = container.querySelector<HTMLElement>(
      '[data-testid="xterm-selection-drag-region"]'
    )
    expect(region).toBeInstanceOf(HTMLElement)
    expect(region).toHaveAttribute('draggable', 'true')

    const values = new Map<string, string>()
    const dataTransfer = {
      types: [] as string[],
      effectAllowed: 'none',
      getData: (type: string) => values.get(type) ?? '',
      setData: (type: string, value: string) => {
        values.set(type, value)
        dataTransfer.types.push(type)
      },
    } as unknown as DataTransfer
    fireEvent.mouseDown(region as HTMLElement, { button: 0 })
    expect(container).toContainElement(region)
    fireEvent.dragStart(region as HTMLElement, { dataTransfer })

    expect(dataTransfer.getData('text/plain')).toBe('terminal output')
    expect(dataTransfer.getData(SELECTED_TEXT_DRAG_TYPE)).toBe('true')

    selectedText = ''
    terminal.buffer.active.getLine = () => ({
      translateToString: () => 'automated selection',
    })
    terminal.select = vi.fn(() => {
      selectedText = 'automated selection'
    })
    const automationContainer = container as HTMLElement & {
      __weworkSelectTextForE2E?: (value: string) => string
      __weworkTextForE2E?: () => string
    }
    expect(automationContainer.__weworkTextForE2E?.()).toBe('automated selection')
    expect(automationContainer.__weworkSelectTextForE2E?.('automated selection')).toBe(
      'automated selection'
    )
    expect(selections.at(-1)).toEqual({
      source: expect.stringMatching(/^terminal:/),
      text: 'automated selection',
      rect: { left: 0, top: 0, width: 150, height: 10 },
    })

    controller.dispose()
    expect(automationContainer.__weworkTextForE2E).toBeUndefined()
    expect(selections.at(-1)).toEqual({
      source: expect.stringMatching(/^terminal:/),
      text: null,
      rect: null,
    })
    window.removeEventListener(SELECTED_TEXT_CHANGED_EVENT, handleSelection)
    expect(container).not.toContainElement(region)
  })

  test('selects the latest matching text from the xterm buffer', () => {
    let selectedText = ''
    const select = vi.fn((column: number, row: number, length: number) => {
      selectedText = lines[row]?.slice(column, column + length) ?? ''
    })
    const lines = ['older marker', 'prompt', 'latest marker']
    const terminal = {
      buffer: {
        active: {
          length: lines.length,
          getLine: (row: number) => ({
            translateToString: () => lines[row] ?? '',
          }),
        },
      },
      getSelection: () => selectedText,
      select,
    } as unknown as Pick<Terminal, 'buffer' | 'getSelection' | 'select'>

    expect(selectXtermBufferText(terminal, 'marker')).toBe('marker')
    expect(select).toHaveBeenCalledWith(7, 2, 6)
  })

  test('reads text directly from the xterm buffer', () => {
    const lines = ['first line', '', 'latest output']
    const terminal = {
      buffer: {
        active: {
          length: lines.length,
          getLine: (row: number) => ({
            translateToString: () => lines[row] ?? '',
          }),
        },
      },
    } as unknown as Pick<Terminal, 'buffer'>

    expect(readXtermBufferText(terminal)).toBe('first line\n\nlatest output')
  })
})
