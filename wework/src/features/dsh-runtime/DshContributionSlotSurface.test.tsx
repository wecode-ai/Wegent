import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { clearDshUiModuleCache } from './dshUiModules'
import { WEWORK_DSH_SLOTS } from './dshUiSlots'
import { DshContributionSlotSurface } from './DshContributionSlotSurface'

vi.mock('./DshSlotSurface', () => ({
  DshSlotSurface: ({ entryId, props }: { entryId: string; props: { label: string } }) => (
    <div data-testid={`attached-contribution-${entryId}`}>
      {entryId}:{props.label}
    </div>
  ),
}))

describe('DshContributionSlotSurface', () => {
  const modulePath = 'plugins/test-task-status.js'
  const entries = [{ id: 'module-status', module: modulePath }, { id: 'attached-status' }]

  beforeEach(() => {
    clearDshUiModuleCache()
    window.__WEWORK_DSH_UI__ = {
      getEntries: slot => (slot === WEWORK_DSH_SLOTS.taskStatus ? entries : []),
      subscribe: () => () => {},
      attach: () => ({ update: () => {}, dispose: () => {} }),
    }
    window.__WEWORK_DSH_UI_MODULES__ = {
      [modulePath]: {
        default: ({ label }: { label: string }) => (
          <span data-testid="module-contribution">{label}</span>
        ),
      },
    }
  })

  afterEach(() => {
    delete window.__WEWORK_DSH_UI_MODULES__
  })

  test('renders first-party modules and standard DSH components through the same slot', async () => {
    await act(async () => {
      render(
        <DshContributionSlotSurface
          props={{ label: 'generic status' }}
          slot={WEWORK_DSH_SLOTS.taskStatus}
        />
      )
    })

    expect(screen.getByTestId('module-contribution')).toHaveTextContent('generic status')
    expect(screen.getByTestId('attached-contribution-attached-status')).toHaveTextContent(
      'attached-status:generic status'
    )
    expect(
      screen
        .getByTestId('module-contribution')
        .compareDocumentPosition(screen.getByTestId('attached-contribution-attached-status'))
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })
})
