import { fireEvent } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { SELECTED_TEXT_DRAG_TYPE } from '@/lib/selected-text-drag'
import { installCodeViewTextDrag } from './codeViewTextDrag'

describe('CodeView text drag', () => {
  test('makes selected shadow-DOM lines draggable with the selected text payload', async () => {
    const host = document.createElement('div')
    const codeView = document.createElement('diffs-container')
    const shadow = codeView.attachShadow({ mode: 'open' })
    const selectedLine = document.createElement('div')
    selectedLine.dataset.line = '2'
    selectedLine.dataset.selectedLine = ''
    selectedLine.dataset.testid = 'existing-line'
    selectedLine.setAttribute('draggable', 'false')
    vi.spyOn(selectedLine, 'getBoundingClientRect').mockReturnValue({
      bottom: 80,
      height: 20,
      left: 40,
      right: 240,
      top: 60,
      width: 200,
      x: 40,
      y: 60,
      toJSON: () => ({}),
    })
    shadow.append(selectedLine)
    host.append(codeView)

    const onSelectionRectChange = vi.fn()
    const dispose = installCodeViewTextDrag(host, 'const selected = true', onSelectionRectChange)
    await new Promise(resolve => requestAnimationFrame(resolve))

    expect(selectedLine).toHaveAttribute('draggable', 'true')
    expect(selectedLine).toHaveAttribute('data-testid', 'workspace-preview-selection-drag-region')
    expect(onSelectionRectChange).toHaveBeenCalledWith({
      left: 40,
      top: 60,
      width: 200,
      height: 20,
    })
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

    fireEvent.dragStart(selectedLine, { dataTransfer })

    expect(dataTransfer.getData('text/plain')).toBe('const selected = true')
    expect(dataTransfer.getData(SELECTED_TEXT_DRAG_TYPE)).toBe('true')
    dispose()
    expect(selectedLine).toHaveAttribute('draggable', 'false')
    expect(selectedLine).toHaveAttribute('data-testid', 'existing-line')
  })
})
