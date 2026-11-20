import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import '@/i18n'
import { useAssignmentNotificationChoice } from './useAssignmentNotificationChoice'

it('settles explicit choices, cancels replaced requests and releases a detached dialog', async () => {
  let choice!: ReturnType<typeof useAssignmentNotificationChoice>
  function Harness() {
    choice = useAssignmentNotificationChoice()
    return choice.dialog
  }
  const { unmount } = render(<Harness />)
  let first!: Promise<boolean | null>
  act(() => {
    first = choice.request()
  })
  expect(screen.getByRole('dialog')).toBeVisible()
  let second!: Promise<boolean | null>
  act(() => {
    second = choice.request()
  })
  await expect(first).resolves.toBeNull()
  await userEvent.click(screen.getByTestId('wework-board-notify-confirm'))
  await expect(second).resolves.toBe(true)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  act(() => {
    first = choice.request()
  })
  await userEvent.click(screen.getByTestId('wework-board-notify-confirm-cancel-button'))
  await expect(first).resolves.toBe(false)
  act(() => {
    first = choice.request()
  })
  unmount()
  await expect(first).resolves.toBeNull()
  await expect(choice.request()).resolves.toBeNull()
})
