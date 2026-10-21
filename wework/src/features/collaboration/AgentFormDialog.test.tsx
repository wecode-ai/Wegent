import { useEffect, useState } from 'react'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { AgentFormDialog } from '@wegent/collaboration'

it('waits for the Agent configuration before exposing editable fields', async () => {
  let resolve!: (name: string) => void
  const load = new Promise<string>(settle => {
    resolve = settle
  })
  const save = vi.fn()
  function Editor() {
    const [loading, setLoading] = useState(true)
    const [name, setName] = useState('')
    useEffect(() => {
      void load.then(value => {
        setName(value)
        setLoading(false)
      })
    }, [])
    return (
      <AgentFormDialog
        busy={false}
        description="Edit the Agent"
        displayName={{ label: 'Agent name', value: name, onChange: setName, testId: 'agent-name' }}
        labels={{
          advanced: 'Advanced',
          advancedDescription: 'Settings',
          cancel: 'Cancel',
          close: 'Close',
          owner: 'Owner',
        }}
        loading={loading}
        loadingLabel="Loading Agent configuration"
        onClose={() => {}}
        onSave={() => save(name)}
        ownerLabel="Local device"
        prompt={{
          label: 'Instructions',
          value: '',
          onChange: () => {},
          testId: 'agent-instructions',
        }}
        saveDisabled={loading}
        saveLabel="Save"
        savingLabel="Saving"
        testIds={{
          backdrop: 'agent-backdrop',
          close: 'agent-close',
          dialog: 'agent-dialog',
          error: 'agent-error',
          save: 'agent-save',
        }}
        title="Agent"
      />
    )
  }
  render(<Editor />)
  expect(screen.getByText('Loading Agent configuration')).toBeVisible()
  expect(screen.queryByRole('textbox', { name: 'Agent name' })).not.toBeInTheDocument()
  await act(async () => resolve('Original Agent'))
  const input = screen.getByRole('textbox', { name: 'Agent name' })
  expect(input).toHaveValue('Original Agent')
  await userEvent.clear(input)
  await userEvent.type(input, 'Edited Agent')
  await userEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(save).toHaveBeenCalledWith('Edited Agent')
})
