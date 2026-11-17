import '@/i18n'
import { runtimeItem } from '@/features/notifications/standInNotifications.fixtures'
import {
  RuntimeInteractionsContext,
  type RuntimeInteractionsValue,
} from '@/features/notifications/RuntimeInteractionsContext'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { StandInOverviewPage } from './StandInOverviewPage'
import { standInOverviewFixture } from './StandInOverviewPage.testFixtures'

vi.mock('./StandInWorkConfirmation', () => ({ StandInWorkConfirmation: () => null }))
vi.mock('./StandInConversation', () => ({
  StandInConversation: () => (
    <input aria-label="Conversation draft" data-testid="conversation-draft" />
  ),
}))

const waiting = {
  ...runtimeItem,
  task: { ...runtimeItem.task, interactionStatus: 'awaitingUserReply' as const },
}
const workbench = {
  runtimeTaskReminders: { items: [waiting] },
} as unknown as WorkbenchContextValue

async function openWorkReview() {
  const details = await screen.findByTestId('stand-in-details-open')
  await waitFor(() => expect(details).toBeEnabled())
  await userEvent.click(details)
  await userEvent.click(await screen.findByTestId('stand-in-role-chat'))
  await userEvent.click(await screen.findByTestId('stand-in-activity-task-task'))
}

it('closes work review when handing a waiting task to the existing interaction navigation', async () => {
  const { props } = standInOverviewFixture()
  const open = vi.fn()
  const interactions = {
    pending: [{ id: 'task-permission', task: waiting }],
    open,
  } as unknown as RuntimeInteractionsValue
  const page = (active = true) => (
    <WorkbenchContext.Provider value={workbench}>
      <RuntimeInteractionsContext.Provider value={interactions}>
        <StandInOverviewPage {...props} initialSelectedRoleId="default" active={active} />
      </RuntimeInteractionsContext.Provider>
    </WorkbenchContext.Provider>
  )
  const view = render(page())
  await openWorkReview()
  expect(screen.getByTestId('stand-in-work-dialog')).toBeVisible()
  await userEvent.click(screen.getByTestId('stand-in-work-open-pending'))
  expect(open).toHaveBeenCalledExactlyOnceWith('task-permission')
  expect(screen.queryByTestId('stand-in-work-dialog')).not.toBeInTheDocument()
  view.rerender(page(false))
  view.rerender(page())
  expect(screen.queryByTestId('stand-in-work-dialog')).not.toBeInTheDocument()
  expect(screen.getByTestId('stand-in-overview-role-default')).toBeVisible()
})

it('suspends an inactive owner review without clearing its conversation draft or review intent', async () => {
  const { props } = standInOverviewFixture()
  const page = (active: boolean) => (
    <WorkbenchContext.Provider value={workbench}>
      <StandInOverviewPage {...props} initialSelectedRoleId="default" active={active} />
    </WorkbenchContext.Provider>
  )
  const view = render(page(true))
  const draft = await screen.findByTestId('conversation-draft')
  await userEvent.type(draft, '继续这份草稿')
  await openWorkReview()
  view.rerender(page(false))
  expect(screen.queryByTestId('stand-in-work-dialog')).not.toBeInTheDocument()
  expect(screen.getByTestId('conversation-draft')).toBe(draft)
  expect(draft).toHaveValue('继续这份草稿')
  view.rerender(page(true))
  expect(screen.getByTestId('stand-in-work-dialog')).toBeVisible()
  expect(draft).toHaveValue('继续这份草稿')
})
