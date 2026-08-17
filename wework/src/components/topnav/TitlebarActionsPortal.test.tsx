import { Activity, useLayoutEffect } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import {
  TITLEBAR_FEEDBACK_PORTAL_ID,
  TitlebarFeedbackPortal,
  WorkspaceTabPortalOwner,
} from './TitlebarActionsPortal'
import { setActiveWorkspaceTabPortalOwner } from './workspaceTabPortalOwnership'

function PortalHarness({ activeOwner }: { activeOwner: 'first' | 'second' }) {
  useLayoutEffect(() => {
    setActiveWorkspaceTabPortalOwner(activeOwner)
  }, [activeOwner])

  return (
    <>
      <div id={TITLEBAR_FEEDBACK_PORTAL_ID} />
      <WorkspaceTabPortalOwner ownerId="first">
        <Activity mode={activeOwner === 'first' ? 'visible' : 'hidden'}>
          <TitlebarFeedbackPortal>
            <span data-testid="first-portal">First</span>
          </TitlebarFeedbackPortal>
        </Activity>
      </WorkspaceTabPortalOwner>
      <WorkspaceTabPortalOwner ownerId="second">
        <Activity mode={activeOwner === 'second' ? 'visible' : 'hidden'}>
          <TitlebarFeedbackPortal>
            <span data-testid="second-portal">Second</span>
          </TitlebarFeedbackPortal>
        </Activity>
      </WorkspaceTabPortalOwner>
    </>
  )
}

describe('workspace tab titlebar portal ownership', () => {
  test('hides stale portal content when React keeps an inactive Activity mounted', async () => {
    const { rerender } = render(<PortalHarness activeOwner="first" />)

    await waitFor(() => expect(screen.getByTestId('first-portal')).toBeVisible())

    rerender(<PortalHarness activeOwner="second" />)

    await waitFor(() => expect(screen.getByTestId('second-portal')).toBeVisible())
    expect(screen.getByTestId('first-portal').parentElement).toHaveAttribute('hidden')
    expect(screen.getByTestId('second-portal').parentElement).not.toHaveAttribute('hidden')
  })
})
