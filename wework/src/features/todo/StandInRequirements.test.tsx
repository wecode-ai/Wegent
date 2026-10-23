import { useState } from 'react'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { newStandInRole } from '@/api/personalStandIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import '@/i18n'
import { StandInRequirements } from './StandInRequirements'

let publishPrompt: (prompt: string) => void
vi.mock('@/components/layout/BufferedChatInput', () => ({
  BufferedChatInput: ({ onChange }: { onChange(prompt: string): void }) => {
    publishPrompt = onChange
    return <div data-testid="stand-in-prompt" />
  },
}))

function Fixture() {
  const [role, setRole] = useState(newStandInRole('mac', 'default'))
  return (
    <>
      <StandInRequirements
        role={role}
        services={{} as WorkbenchServices}
        onChange={setRole}
        disabled={false}
        onSave={() => {}}
      />
      <button
        data-testid="toggle-enabled"
        onClick={() => setRole(current => ({ ...current, enabled: !current.enabled }))}
      >
        Toggle
      </button>
      <output data-testid="latest-role">
        {JSON.stringify({ enabled: role.enabled, prompt: role.prompt })}
      </output>
    </>
  )
}

it('preserves newer fields when an earlier composer callback publishes a delayed prompt', async () => {
  const user = userEvent.setup()
  render(<Fixture />)
  expect(screen.getByTestId('stand-in-prompt')).toBeInTheDocument()
  const delayed = publishPrompt
  await user.click(screen.getByTestId('toggle-enabled'))
  act(() => delayed('Review carefully'))
  expect(JSON.parse(screen.getByTestId('latest-role').textContent!)).toEqual({
    enabled: true,
    prompt: 'Review carefully',
  })
})
