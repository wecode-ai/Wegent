import { useEffect, useState } from 'react'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { AgentFormDialog } from '@wegent/collaboration'

it('keeps responsibilities and tools visible while runtime settings expand independently', async () => {
  const user = userEvent.setup()
  const activateRuntime = vi.fn()
  const save = vi.fn()
  function Editor() {
    const [prompt, setPrompt] = useState('Review changes')
    return (
      <AgentFormDialog
        title="Edit Agent"
        description="Set responsibilities, tools, and how this Agent runs."
        busy={false}
        onClose={() => {}}
        onSave={() => save(prompt)}
        ownerLabel="Project Alpha"
        displayName={{ label: 'Name', value: 'Reviewer', onChange: () => {}, testId: 'agent-name' }}
        prompt={{
          label: 'Responsibilities',
          value: prompt,
          onChange: setPrompt,
          testId: 'agent-prompt',
        }}
        labels={{
          advanced: 'Tools and skills',
          advancedDescription: 'Available tools',
          cancel: 'Cancel',
          close: 'Close',
          owner: 'Saved in',
        }}
        advancedSummary={{
          title: 'Use device tools',
          description: 'Tools depend on the device that runs the task.',
        }}
        capabilities={<input aria-label="MCP tools" defaultValue="browser" />}
        runtimeSettings={{
          label: 'How it runs',
          environment: { label: 'Environment', value: 'Project environments' },
          model: { label: 'Model', value: 'Model Alpha' },
          onOpen: activateRuntime,
        }}
        executionControl={
          <select aria-label="Environment">
            <option>Project environments</option>
          </select>
        }
        modelControl={
          <select aria-label="Model">
            <option>Model Alpha</option>
          </select>
        }
        saveDisabled={false}
        saveLabel="Save"
        savingLabel="Saving"
        testIds={{
          backdrop: 'agent-backdrop',
          close: 'agent-close',
          dialog: 'agent-dialog',
          error: 'agent-error',
          save: 'agent-save',
        }}
      />
    )
  }
  render(<Editor />)
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  expect(screen.getByTestId('agent-dialog-runtime-summary')).toHaveTextContent('Environment')
  expect(screen.getByTestId('agent-dialog-runtime-summary')).toHaveTextContent(
    'Project environments'
  )
  expect(screen.getByTestId('agent-dialog-runtime-summary')).toHaveTextContent('Model')
  expect(screen.getByTestId('agent-dialog-runtime-summary')).toHaveTextContent('Model Alpha')
  await user.clear(screen.getByLabelText('Responsibilities'))
  await user.type(screen.getByLabelText('Responsibilities'), 'Preserved responsibility draft')
  await user.click(screen.getByRole('button', { name: 'Tools and skills' }))
  await user.click(screen.getByRole('button', { name: 'How it runs' }))
  expect(activateRuntime).toHaveBeenCalledOnce()
  expect(screen.getByLabelText('MCP tools')).toBeVisible()
  expect(screen.getByLabelText('Responsibilities')).toBeVisible()
  expect(screen.getByLabelText('Environment')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'How it runs' }))
  expect(screen.getByLabelText('MCP tools')).toBeVisible()
  expect(screen.getByLabelText('Responsibilities')).toHaveValue('Preserved responsibility draft')
  expect(
    Array.from(screen.getByTestId('agent-dialog').querySelectorAll('footer button')).map(
      button => button.textContent
    )
  ).toEqual(['Cancel', 'Save'])
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(save).toHaveBeenCalledExactlyOnceWith('Preserved responsibility draft')
})

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

it('does not submit the Agent when Enter belongs to a nested native dialog', async () => {
  const user = userEvent.setup()
  const save = vi.fn()
  render(
    <AgentFormDialog
      busy={false}
      title="Agent"
      description="Configure an Agent"
      ownerLabel="Local"
      labels={{
        advanced: 'Advanced',
        advancedDescription: 'Settings',
        cancel: 'Cancel',
        close: 'Close',
        owner: 'Owner',
      }}
      displayName={{
        label: 'Agent name',
        value: 'Agent',
        onChange: () => {},
        testId: 'agent-name',
      }}
      prompt={{ label: 'Instructions', value: '', onChange: () => {}, testId: 'agent-prompt' }}
      advanced={
        <dialog open aria-label="Nested template">
          <input aria-label="Template name" defaultValue="Draft" />
        </dialog>
      }
      onClose={() => {}}
      onSave={save}
      saveDisabled={false}
      saveLabel="Save"
      savingLabel="Saving"
      testIds={{
        backdrop: 'agent-backdrop',
        close: 'agent-close',
        dialog: 'agent-dialog',
        error: 'agent-error',
        save: 'agent-save',
      }}
    />
  )
  await user.click(screen.getByLabelText('Template name'))
  await user.keyboard('{Enter}')
  expect(save).not.toHaveBeenCalled()
  await user.click(screen.getByLabelText('Agent name'))
  await user.keyboard('{Enter}')
  expect(save).toHaveBeenCalledOnce()
})
