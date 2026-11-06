import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import '@/i18n'
import type { RuntimeCommandReceipt, RuntimeTaskCommandsApi } from '@/api/runtimeTaskCommands'
import { RuntimeCommandRecoveryReview } from './RuntimeCommandRecoveryReview'

const target = { taskId: 'opaque-task', commandId: 'opaque-command', userId: 7 }
const receipt: RuntimeCommandReceipt = {
  success: true,
  accepted: true,
  ...target,
  taskTitle: '原来的后台工作',
  commandFingerprint: 'opaque-fingerprint',
  native: [4, 'opaque-thread', 'opaque-turn'],
  state: 'recovery_required',
  acceptedAt: 1000,
  runtime: 'codex',
  requiresUserReview: true,
  nativeOutcome: 'unknown',
}
const abandoned: RuntimeCommandReceipt = { ...receipt, state: 'abandoned' }

function fixture(initial = receipt) {
  const commands: RuntimeTaskCommandsApi = {
    get: vi.fn().mockResolvedValue(initial),
    resolve: vi.fn().mockResolvedValue(abandoned),
  }
  const onCancel = vi.fn()
  const onContinue = vi.fn().mockResolvedValue(undefined)
  const view = render(
    <RuntimeCommandRecoveryReview
      commands={commands}
      deviceId="owner-device"
      target={target}
      onCancel={onCancel}
      onContinue={onContinue}
    />
  )
  return { commands, onCancel, onContinue, view }
}

it('reviews a readable title and unknown outcome inline; cancelling performs no resolution', async () => {
  const f = fixture()
  expect(await screen.findByTestId('runtime-command-recovery-task')).toHaveTextContent(
    '原来的后台工作'
  )
  const review = screen.getByTestId('runtime-command-recovery-review')
  expect(review).toHaveTextContent('不重放旧请求')
  expect(review).toHaveTextContent('保留已发生的操作及记录')
  expect(review).not.toHaveTextContent('opaque-')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('heading', { name: '核对中断的执行' })).toHaveFocus()
  const accepted = screen.getByTestId('runtime-command-recovery-accepted-at')
  expect(accepted).toHaveTextContent('请求接收时间：')
  expect(accepted.querySelector('time')).toHaveAttribute(
    'datetime',
    new Date(receipt.acceptedAt).toISOString()
  )
  expect(accepted.querySelector('time')?.textContent).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/)
  await userEvent.keyboard('{Enter}')
  expect(f.commands.resolve).not.toHaveBeenCalled()
  await userEvent.click(screen.getByTestId('runtime-command-recovery-cancel'))
  expect(f.onCancel).toHaveBeenCalledOnce()
  expect(f.commands.resolve).not.toHaveBeenCalled()
  expect(f.onContinue).not.toHaveBeenCalled()
})

it('resolves once with the reviewed identity before continuing, preserving the unknown outcome', async () => {
  const f = fixture()
  let finish!: (value: RuntimeCommandReceipt) => void
  vi.mocked(f.commands.resolve).mockReturnValue(new Promise(resolve => (finish = resolve)))
  const confirm = await screen.findByTestId('runtime-command-recovery-confirm')
  await userEvent.dblClick(confirm)
  expect(f.commands.resolve).toHaveBeenCalledOnce()
  expect(f.commands.resolve).toHaveBeenCalledWith('owner-device', {
    ...target,
    expectedFingerprint: receipt.commandFingerprint,
    expectedNative: receipt.native,
    decision: 'abandon',
    requestId: expect.any(String),
  })
  expect(f.onContinue).not.toHaveBeenCalled()
  finish(abandoned)
  await waitFor(() => expect(f.onContinue).toHaveBeenCalledOnce())
  expect(
    await screen.findByText('已恢复后续事项检查。原执行结果仍未知，旧请求没有重放。')
  ).toBeVisible()
})

it('can continue after a failed check without resolving a second time', async () => {
  const f = fixture()
  f.onContinue.mockRejectedValueOnce(new Error('offline'))
  await userEvent.click(await screen.findByTestId('runtime-command-recovery-confirm'))
  expect(await screen.findByRole('alert')).toHaveTextContent('无需再次放弃原结果')
  await userEvent.click(screen.getByTestId('runtime-command-recovery-confirm'))
  await waitFor(() => expect(f.onContinue).toHaveBeenCalledTimes(2))
  expect(f.commands.resolve).toHaveBeenCalledOnce()
})

it('reopens an abandoned receipt by continuing checks, without resolving or replaying it', async () => {
  const f = fixture(abandoned)
  await userEvent.click(await screen.findByTestId('runtime-command-recovery-confirm'))
  expect(f.commands.resolve).not.toHaveBeenCalled()
  expect(f.onContinue).toHaveBeenCalledOnce()
})

it.each(['command_resolution_conflict', 'command_resolution_active', 'permission_denied'])(
  '%s requires a new review and never proceeds to a check',
  async code => {
    const f = fixture()
    vi.mocked(f.commands.resolve).mockRejectedValueOnce(
      Object.assign(new Error('private detail'), { code })
    )
    await userEvent.click(await screen.findByTestId('runtime-command-recovery-confirm'))
    expect(await screen.findByRole('alert')).not.toHaveTextContent('private detail')
    expect(screen.queryByTestId('runtime-command-recovery-confirm')).toBeNull()
    expect(f.onContinue).not.toHaveBeenCalled()
    vi.mocked(f.commands.get).mockResolvedValueOnce({
      ...receipt,
      commandFingerprint: 'new-version',
      native: null,
    })
    await userEvent.click(screen.getByTestId('runtime-command-recovery-refresh'))
    await userEvent.click(await screen.findByTestId('runtime-command-recovery-confirm'))
    expect(f.commands.resolve).toHaveBeenLastCalledWith(
      'owner-device',
      expect.objectContaining({
        expectedFingerprint: 'new-version',
        expectedNative: null,
      })
    )
  }
)

it.each(['started', 'settled', 'awaiting_user'] as const)(
  'does not offer abandonment for a current %s receipt',
  async state => {
    const f = fixture({ ...receipt, state })
    await screen.findByTestId('runtime-command-recovery-task')
    expect(screen.queryByTestId('runtime-command-recovery-confirm')).toBeNull()
    expect(f.commands.resolve).not.toHaveBeenCalled()
    expect(f.onContinue).not.toHaveBeenCalled()
  }
)

it('does not confirm a receipt for a different command or without the current fingerprint', async () => {
  const f = fixture({ ...receipt, commandFingerprint: '', commandId: 'another-command' })
  await screen.findByTestId('runtime-command-recovery-task')
  expect(screen.queryByTestId('runtime-command-recovery-confirm')).toBeNull()
  expect(f.commands.resolve).not.toHaveBeenCalled()
})

it('requires a fresh read when the owner device changes', async () => {
  const f = fixture()
  await screen.findByTestId('runtime-command-recovery-confirm')
  vi.mocked(f.commands.get).mockReturnValueOnce(new Promise(() => {}))
  f.view.rerender(
    <RuntimeCommandRecoveryReview
      commands={f.commands}
      deviceId="another-device"
      target={target}
      onCancel={f.onCancel}
      onContinue={f.onContinue}
    />
  )
  expect(screen.queryByTestId('runtime-command-recovery-confirm')).toBeNull()
  expect(f.commands.get).toHaveBeenLastCalledWith('another-device', target)
  expect(f.commands.resolve).not.toHaveBeenCalled()
})

it('does not check subsequent work if the resolver returns an unconfirmed result', async () => {
  const f = fixture()
  vi.mocked(f.commands.resolve).mockResolvedValueOnce(receipt)
  await userEvent.click(await screen.findByTestId('runtime-command-recovery-confirm'))
  expect(await screen.findByRole('alert')).toHaveTextContent('重新读取')
  expect(f.onContinue).not.toHaveBeenCalled()
  expect(screen.queryByTestId('runtime-command-recovery-confirm')).toBeNull()
})
