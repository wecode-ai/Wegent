import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, test, vi } from 'vitest'
import { chooseDesktopControlOption, selectDesktopControlOption } from './desktop-control-select'
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

test.each([true, false])(
  'chooses the currently mounted responsive control (compact=%s)',
  compact => {
    const container = document.createElement('div')
    document.body.append(container)
    const initial = document.createElement(compact ? 'button' : 'select')
    container.append(initial)
    const onChoose = vi.fn()
    const mounted = compact ? createSelect() : document.createElement('button')
    if (!compact) mounted.addEventListener('click', onChoose)
    initial.replaceWith(mounted)

    chooseDesktopControlOption(container.querySelector('select, button')!, 'local:project-space-id')

    if (compact) expect((mounted as HTMLSelectElement).value).toBe('local:project-space-id')
    else expect(onChoose).toHaveBeenCalledOnce()
  }
)

test('rejects unrelated elements as choice targets', () => {
  expect(() => chooseDesktopControlOption(document.createElement('div'), 'board')).toThrow(
    'Choice target must be a select or button element'
  )
})

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

  test('captures the mounted options when an opted-in selection is missing', () => {
    const select = createSelect()
    select.options[1].disabled = true

    expect(() => selectDesktopControlOption(select, 'missing', 'value', true)).toThrow(
      'Unable to find select option by value "missing"; select={"selectedValue":"","selectedLabel":"None","options":[{"value":"","label":"None","disabled":false},{"value":"local:project-space-id","label":"Task Follow-up Board","disabled":true}]}'
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
    await act(async () => {
      selectDesktopControlOption(select!, '')
    })
    expect(await selectDesktopControlChoice(select!, 'team:88001')).toBe('Board Review Agent')
    await act(async () => {
      save!.click()
    })
    expect(savedValues).toEqual(['team:88001', 'team:88001'])
    await act(async () => root.unmount())
  })
})

import '../../../packages/collaboration/src/test/setup'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@ui-sdk/react/select'
import { SelectField } from '@wegent/collaboration/controls/SelectField'
import { SearchableSelect } from '@wegent/collaboration/controls/SearchableSelect'
import { desktopControlSelectionValue, selectDesktopControlChoice } from './desktop-control-select'

async function sdkFixture(
  kind: 'select' | 'combobox' | 'cancel' | 'reject' | 'raw',
  disabled = false,
  disabledOption = false
) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const saved: string[] = []
  function Form() {
    const [value, setValue] = useState('first')
    const common = {
      value,
      onChange: kind === 'reject' ? () => {} : setValue,
      testId: 'sdk-choice',
      accessibleLabel: 'Project',
      options: [
        { value: 'first', label: 'First project' },
        { value: 'second', label: 'Second project', disabled: disabledOption },
      ],
      disabled,
    }
    return (
      <>
        {kind === 'cancel' || kind === 'raw' ? (
          <Select
            value={value}
            onValueChange={(next, details) => {
              if (kind === 'cancel') details.cancel()
              else if (next !== null) setValue(next)
            }}
          >
            <SelectTrigger data-testid="sdk-choice" aria-label="Project">
              <SelectValue />
            </SelectTrigger>
            <SelectContent keepMounted>
              <SelectItem value="first">First project</SelectItem>
              <SelectItem value="second">Second project</SelectItem>
              <SelectItem value="" data-value="">
                Unassigned
              </SelectItem>
            </SelectContent>
          </Select>
        ) : kind === 'combobox' ? (
          <SearchableSelect
            {...common}
            searchPlaceholder="Search projects"
            emptyLabel="No projects"
          />
        ) : (
          <SelectField {...common} />
        )}
        <output>{value}</output>
        <button data-testid="sdk-save" onClick={() => saved.push(value)}>
          Save
        </button>
      </>
    )
  }
  await act(async () => root.render(<Form />))
  return {
    container,
    root,
    saved,
    element: container.querySelector<HTMLElement>('[data-testid="sdk-choice"]')!,
  }
}

for (const kind of ['select', 'combobox', 'raw'] as const) {
  test.each(['value', 'label'] as const)(
    `selects a real SDK ${kind} by %s and saves committed owner state`,
    async mode => {
      const fixture = await sdkFixture(kind)
      try {
        expect(await desktopControlSelectionValue(fixture.element)).toBe('first')
        expect(
          await selectDesktopControlChoice(
            fixture.element,
            mode === 'value' ? 'second' : 'Second project',
            mode
          )
        ).toBe('Second project')
        await act(async () =>
          fixture.container.querySelector<HTMLButtonElement>('[data-testid="sdk-save"]')!.click()
        )
        expect(await desktopControlSelectionValue(fixture.element)).toBe('second')
        expect(fixture.saved).toEqual(['second'])
        expect(fixture.container.querySelector('output')!.textContent).toBe('second')
      } finally {
        await act(async () => fixture.root.unmount())
        fixture.container.remove()
      }
    }
  )
}

test('clears an SDK selection when the list offers an empty value', async () => {
  const fixture = await sdkFixture('raw')
  try {
    expect(await selectDesktopControlChoice(fixture.element, '')).toBe('Unassigned')
    expect(await desktopControlSelectionValue(fixture.element)).toBe('')
    expect(fixture.container.querySelector('output')?.textContent).toBe('')
  } finally {
    await act(async () => fixture.root.unmount())
    fixture.container.remove()
  }
})

test('retains requested option diagnostics through unified selection', async () => {
  const native = createSelect()
  await expect(selectDesktopControlChoice(native, 'missing', 'value', 1000, true)).rejects.toThrow(
    'selectedLabel":"None"'
  )
  native.remove()

  const fixture = await sdkFixture('select')
  try {
    await act(async () => {
      await expect(
        selectDesktopControlChoice(fixture.element, 'missing', 'value', 1000, true)
      ).rejects.toThrow('"label":"First project"')
    })
  } finally {
    await act(async () => fixture.root.unmount())
    fixture.container.remove()
  }
})

for (const kind of ['cancel', 'reject'] as const) {
  test(`rejects SDK success when the business owner ${kind}s selection`, async () => {
    const fixture = await sdkFixture(kind)
    try {
      await expect(
        selectDesktopControlChoice(fixture.element, 'second', 'value', 30)
      ).rejects.toThrow('Selection was not accepted')
      await act(async () =>
        fixture.container.querySelector<HTMLButtonElement>('[data-testid="sdk-save"]')!.click()
      )
      expect(await desktopControlSelectionValue(fixture.element)).toBe('first')
      expect(fixture.saved).toEqual(['first'])
    } finally {
      await act(async () => fixture.root.unmount())
      fixture.container.remove()
    }
  })
}

test.each([true, false])(
  'rejects SDK disabled or missing choices without changing state (disabled=%s)',
  async disabled => {
    const fixture = await sdkFixture('select', disabled)
    try {
      await expect(
        selectDesktopControlChoice(fixture.element, disabled ? 'second' : 'missing')
      ).rejects.toThrow(disabled ? 'disabled' : 'Unable to find select option')
      expect(fixture.container.querySelector('output')!.textContent).toBe('first')
    } finally {
      await act(async () => fixture.root.unmount())
      fixture.container.remove()
    }
  }
)

test('rejects a disabled native option before dispatching a change', () => {
  const select = createSelect()
  select.options[1].disabled = true
  expect(() => selectDesktopControlOption(select, 'local:project-space-id')).toThrow('disabled')
  expect(select.value).toBe('')
  select.remove()
})

test('rejects an SDK disabled option without accepting owner state', async () => {
  const fixture = await sdkFixture('select', false, true)
  try {
    await expect(selectDesktopControlChoice(fixture.element, 'second')).rejects.toThrow()
    expect(fixture.container.querySelector('output')!.textContent).toBe('first')
  } finally {
    await act(async () => fixture.root.unmount())
    fixture.container.remove()
  }
})
