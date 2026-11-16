import { beforeEach, describe, expect, test } from 'vitest'
import { prepareSelectedTextDrag, SELECTED_TEXT_DRAG_TYPE } from './selected-text-drag'

describe('selected text drag', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    window.getSelection()?.removeAllRanges()
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
})
