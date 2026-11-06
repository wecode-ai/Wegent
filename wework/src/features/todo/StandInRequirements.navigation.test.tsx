import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { newStandInRole } from '@/api/personalStandIn'
import {
  WorkspaceTabsContext,
  type WorkspaceTabsContextValue,
} from '@/features/workspace-tabs/workspaceTabsContextValue'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import '@/i18n'
import { StandInRequirements } from './StandInRequirements'

it('opens the marketplace separately without replacing the requirements draft', async () => {
  const user = userEvent.setup()
  const openTab = vi.fn()
  function Fixture() {
    const [role, setRole] = useState(newStandInRole('device', 'reviewer'))
    return (
      <WorkspaceTabsContext.Provider value={{ openTab } as unknown as WorkspaceTabsContextValue}>
        <StandInRequirements
          role={role}
          services={{} as WorkbenchServices}
          onChange={setRole}
          onSave={vi.fn()}
          disabled={false}
        />
      </WorkspaceTabsContext.Provider>
    )
  }
  render(<Fixture />)
  const editor = screen.getByTestId('stand-in-prompt')
  await user.click(editor)
  await user.paste('Keep these requirements /')
  await user.click(await screen.findByTestId('slash-command-option-plugin-marketplace'))
  expect(openTab).toHaveBeenCalledWith('auxiliary', { contentRoute: '/plugins' })
  expect(screen.getByTestId('stand-in-prompt')).toBe(editor)
  expect(editor.textContent).toContain('Keep these requirements')
})
