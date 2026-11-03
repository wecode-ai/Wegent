import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { AddContextMenu } from './AddContextMenu'

describe('AddContextMenu', () => {
  test('explains that pending supervision starts with the task', () => {
    render(
      <AddContextMenu
        disabled={false}
        onFileSelect={vi.fn()}
        onConfigureSupervisor={vi.fn()}
        supervisorEnabled
        supervisorPending
      />
    )

    fireEvent.click(screen.getByTestId('add-context-button'))

    expect(screen.getByTestId('task-supervisor-toggle-button')).toHaveTextContent(
      'workbench.supervisor_pending_menu'
    )
  })
})
