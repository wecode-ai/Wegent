// @vitest-environment jsdom
import { createAgent } from '@ui-sdk/react/agent'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { Field, FieldLabel, FieldDescription } from './Field'
import { Button } from '../markdown/Button'
import { Checkbox } from './Checkbox'
import { SearchableSelect } from './SearchableSelect'
import { SelectField } from './SelectField'
import { Switch } from './Switch'
import { TextField } from './TextField'

const agent = createAgent()

it('lets an unselected combobox commit an explicit empty-value option', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const change = vi.fn()
  try {
    await act(async () =>
      root.render(
        <SearchableSelect
          accessibleLabel="Milestone"
          testId="milestone-choice"
          value={null}
          onChange={change}
          searchPlaceholder="Search milestones"
          emptyLabel="No milestones"
          options={[{ value: '', label: 'Unlink milestone' }]}
        />
      )
    )
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="milestone-choice"]')!.click()
    )
    const unlink = document.querySelector<HTMLElement>('[data-testid="milestone-choice-option-empty"]')!
    expect(unlink.getAttribute('aria-selected')).toBe('false')
    await act(async () => unlink.click())
    expect(change).toHaveBeenCalledExactlyOnceWith('')
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})

function CatalogForm() {
  const [name, setName] = useState('Example')
  const [project, setProject] = useState('one')
  const [person, setPerson] = useState('alex')
  const [notifications, setNotifications] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [saved, setSaved] = useState(false)
  return (
    <>
      <Field>
        <FieldLabel>Name</FieldLabel>
        <TextField
          data-testid="catalog-agent-name"
          value={name}
          onChange={event => setName(event.target.value)}
        />
        <FieldDescription>Give the saved profile a recognizable name.</FieldDescription>
      </Field>
      <SelectField
        accessibleLabel="Project"
        testId="catalog-agent-project"
        value={project}
        onChange={setProject}
        options={[
          { value: 'one', label: 'Project One' },
          { value: 'two', label: 'Project Two' },
        ]}
      />
      <SearchableSelect
        accessibleLabel="Person"
        testId="catalog-agent-person"
        value={person}
        onChange={setPerson}
        searchPlaceholder="Search people"
        emptyLabel="No people"
        options={[
          { value: 'alex', label: 'Alex' },
          { value: 'bo', label: 'Bo' },
        ]}
      />
      <Switch
        aria-label="Notifications"
        data-testid="catalog-agent-notifications"
        checked={notifications}
        onCheckedChange={setNotifications}
      />
      <Checkbox
        aria-label="Confirmation"
        data-testid="catalog-agent-confirmation"
        checked={confirmed}
        onCheckedChange={value => setConfirmed(value === true)}
      />
      <Button data-testid="catalog-agent-save" onClick={() => setSaved(true)}>
        Save
      </Button>
      <output data-testid="catalog-agent-result">
        {JSON.stringify({
          name,
          project,
          person,
          notifications,
          confirmed,
          saved,
        })}
      </output>
    </>
  )
}

it('lets an agent discover and operate the production control composition by accessible names', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<CatalogForm />))
    const entries = agent.snapshot().filter(entry => !entry.offPage && entry.component !== 'more')
    for (const entry of entries) expect(entry.label, `${entry.component} has no name`).toBeTruthy()
    for (const label of ['Name', 'Project', 'Person', 'Notifications', 'Confirmation', 'Save'])
      expect(entries.map(entry => entry.label)).toContain(label)
    const result = await agent.act({
      steps: [
        { ref: 'Name', action: 'setValue', args: ['Atlas'] },
        { ref: 'Project', action: 'setValue', args: ['Project Two'] },
        { ref: 'Person', action: 'setValue', args: ['Bo'] },
        { ref: 'Notifications', action: 'setChecked', args: [true] },
        { ref: 'Confirmation', action: 'setChecked', args: [true] },
        { ref: 'Save', action: 'press', args: [] },
      ],
    })
    await act(async () => {})
    expect(result?.ok, result?.error?.message).toBe(true)
    expect(
      JSON.parse(container.querySelector('[data-testid="catalog-agent-result"]')!.textContent!)
    ).toEqual({
      name: 'Atlas',
      project: 'two',
      person: 'bo',
      notifications: true,
      confirmed: true,
      saved: true,
    })
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})

function UnmountingProjectPicker() {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const [project, setProject] = useState('')
  return (
    <>
      <Button ref={setAnchor} data-testid="external-project-trigger" onClick={() => setOpen(true)}>
        Choose project
      </Button>
      {open && (
        <SearchableSelect
          hideTrigger
          anchor={anchor}
          open
          onOpenChange={setOpen}
          value={project}
          onChange={value => {
            setProject(value)
            setOpen(false)
          }}
          options={[{ value: 'one', label: 'Project One' }]}
          testId="external-project-picker"
          accessibleLabel="Project"
          searchPlaceholder="Search projects"
          emptyLabel="No projects"
        />
      )}
      <output data-testid="selected-project">{project}</output>
    </>
  )
}

it('returns focus to the external trigger when selection unmounts the picker', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<UnmountingProjectPicker />))
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="external-project-trigger"]'
    )!
    await act(async () => trigger.click())
    await act(async () =>
      document
        .querySelector<HTMLElement>('[data-testid="external-project-picker-option-one"]')!
        .click()
    )
    expect(container.querySelector('[data-testid="selected-project"]')?.textContent).toBe('one')
    expect(document.activeElement).toBe(trigger)
    expect(document.querySelector('[data-testid="external-project-picker-menu"]')).toBeNull()
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})

function KeyboardProjectSelect() {
  const [project, setProject] = useState('one')
  return (
    <>
      <SelectField
        accessibleLabel="Keyboard project"
        testId="keyboard-project"
        value={project}
        onChange={setProject}
        options={[
          { value: 'one', label: 'Project One' },
          { value: 'two', label: 'Project Two' },
          { value: 'blocked', label: 'Unavailable project', disabled: true },
        ]}
      />
      <output data-testid="keyboard-project-result">{project}</output>
    </>
  )
}

it('supports keyboard selection after a pointer open, skips disabled choices and dismisses with Escape', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<KeyboardProjectSelect />))
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="keyboard-project"]')!
    const press = async (key: string) =>
      act(async () => {
        trigger.dispatchEvent(
          new KeyboardEvent('keydown', {
            key,
            bubbles: true,
            cancelable: true,
          })
        )
      })
    await act(async () => {
      trigger.focus()
      trigger.click()
    })
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-testid="keyboard-project-menu"]')?.getAttribute('data-side')
      ).toMatch(/^(top|bottom)$/)
    )
    await press('End')
    await vi.waitFor(() =>
      expect(
        document
          .getElementById(trigger.getAttribute('aria-activedescendant') ?? '')
          ?.getAttribute('data-testid')
      ).toBe('keyboard-project-option-two')
    )
    await press('Enter')
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="keyboard-project-result"]')?.textContent).toBe(
        'two'
      )
    )
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
    await act(async () => trigger.click())
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-testid="keyboard-project-menu"]')?.getAttribute('data-side')
      ).toMatch(/^(top|bottom)$/)
    )
    await press('Escape')
    await vi.waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))
    expect(container.querySelector('[data-testid="keyboard-project-result"]')?.textContent).toBe(
      'two'
    )
    expect(document.activeElement).toBe(trigger)
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
