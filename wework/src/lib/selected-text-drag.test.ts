import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  publishSelectedTextSelection,
  SELECTED_TEXT_CHANGED_EVENT,
  prepareSelectedTextDrag,
  SELECTED_TEXT_DRAG_TYPE,
  writeSelectedTextDragData,
} from './selected-text-drag'

describe('selected text drag', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    window.getSelection()?.removeAllRanges()
  })

  test('writes selected text using the shared drag marker', () => {
    const values = new Map<string, string>()
    const dataTransfer = {
      types: [] as string[],
      effectAllowed: 'none',
      getData: (type: string) => values.get(type) ?? '',
      setData: vi.fn((type: string, value: string) => {
        values.set(type, value)
        dataTransfer.types.push(type)
      }),
    } as unknown as DataTransfer

    expect(writeSelectedTextDragData(dataTransfer, 'selected source')).toBe(true)
    expect(dataTransfer.getData('text/plain')).toBe('selected source')
    expect(dataTransfer.types).toContain(SELECTED_TEXT_DRAG_TYPE)
    expect(dataTransfer.effectAllowed).toBe('copy')
  })

  test('publishes normalized selected text changes', () => {
    const listener = vi.fn()
    window.addEventListener(SELECTED_TEXT_CHANGED_EVENT, listener)

    publishSelectedTextSelection('terminal:test', ' selected ')
    publishSelectedTextSelection('terminal:test', '   ', {
      left: 10,
      top: 20,
      width: 30,
      height: 40,
    })

    expect(listener).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        detail: { source: 'terminal:test', text: ' selected ', rect: null },
      })
    )
    expect(listener).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        detail: { source: 'terminal:test', text: null, rect: null },
      })
    )
    window.removeEventListener(SELECTED_TEXT_CHANGED_EVENT, listener)
  })

  test('prepares ordinary DOM selections at the global drag boundary', () => {
    const source = document.createElement('p')
    source.textContent = 'drag this text'
    document.body.append(source)
    const range = document.createRange()
    range.selectNodeContents(source)
    window.getSelection()?.addRange(range)

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
    const event = new Event('dragstart') as DragEvent
    Object.defineProperties(event, {
      dataTransfer: { value: dataTransfer },
      target: { value: source },
    })

    expect(prepareSelectedTextDrag(event)).toBe('drag this text')
    expect(dataTransfer.getData(SELECTED_TEXT_DRAG_TYPE)).toBe('true')
  })

  test('prepares selections spanning sibling elements when dragging from selected content', () => {
    const source = document.createElement('section')
    source.innerHTML = '<span>first</span><span> second</span>'
    document.body.append(source)
    const first = source.firstElementChild as HTMLElement
    const second = source.lastElementChild as HTMLElement
    const range = document.createRange()
    range.setStart(first.firstChild as Text, 0)
    range.setEnd(second.firstChild as Text, second.textContent?.length ?? 0)
    window.getSelection()?.addRange(range)

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
    const event = new Event('dragstart') as DragEvent
    Object.defineProperties(event, {
      dataTransfer: { value: dataTransfer },
      target: { value: first },
    })

    expect(prepareSelectedTextDrag(event)).toBe('first second')
  })
})
