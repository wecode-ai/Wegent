import { describe, expect, test, vi } from 'vitest'
import { selectDesktopControlOption } from './desktop-control-select'

function createSelect() {
  const select = document.createElement('select')
  select.innerHTML = `
    <option value="">None</option>
    <option value="local:project-space-id">Task Follow-up Board</option>
  `
  document.body.append(select)
  return select
}

describe('selectDesktopControlOption', () => {
  test('selects an option by visible label and dispatches React-compatible events', () => {
    const select = createSelect()
    const inputListener = vi.fn()
    const changeListener = vi.fn()
    select.addEventListener('input', inputListener)
    select.addEventListener('change', changeListener)

    expect(selectDesktopControlOption(select, 'Task Follow-up Board', 'label')).toBe(
      'Task Follow-up Board'
    )
    expect(select.value).toBe('local:project-space-id')
    expect(inputListener).toHaveBeenCalledOnce()
    expect(changeListener).toHaveBeenCalledOnce()
  })

  test('selects an option by value by default', () => {
    const select = createSelect()

    expect(selectDesktopControlOption(select, 'local:project-space-id')).toBe(
      'Task Follow-up Board'
    )
    expect(select.value).toBe('local:project-space-id')
  })

  test('rejects an unavailable option', () => {
    const select = createSelect()

    expect(() => selectDesktopControlOption(select, 'Missing board', 'label')).toThrow(
      'Unable to find select option by label "Missing board"'
    )
  })
})
