import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, test, vi } from 'vitest'
import { selectDesktopControlOption } from './desktop-control-select'
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

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

  test('updates React controlled state before a following save click', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const savedValues: string[] = []

    function ControlledSelect() {
      const [value, setValue] = useState('')
      return (
        <>
          <select value={value} onChange={event => setValue(event.target.value)}>
            <option value="">None</option>
            <option value="team:88001">Board Review Agent</option>
          </select>
          <button type="button" onClick={() => savedValues.push(value)}>
            Save
          </button>
        </>
      )
    }

    await act(async () => {
      root.render(<ControlledSelect />)
    })
    const select = container.querySelector('select')
    const save = container.querySelector('button')
    expect(select).not.toBeNull()
    expect(save).not.toBeNull()

    await act(async () => {
      selectDesktopControlOption(select!, 'team:88001')
    })
    await act(async () => {
      save!.click()
    })

    expect(select!.value).toBe('team:88001')
    expect(savedValues).toEqual(['team:88001'])
    await act(async () => root.unmount())
  })
})
