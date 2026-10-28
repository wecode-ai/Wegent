import { act, render, screen, waitFor } from '@testing-library/react'
import '@/i18n'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import { ProviderCredentialRecovery } from './ProviderCredentialRecovery'
import { navigateTo } from '@/lib/navigation'
import {
  readProviderRecovery,
  restoreProviderRecovery,
} from '@/features/model-settings/providerModelConfiguration'

vi.mock('@/features/model-settings/providerModelConfiguration', () => ({
  readProviderRecovery: vi.fn(),
  restoreProviderRecovery: vi.fn(),
}))
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }))
const snapshot = {
  revision: 'protected-revision',
  unreadableArchives: 0,
  cloudConflicts: 0,
  candidates: [
    {
      id: 'opaque',
      kind: 'legacy-models' as const,
      providers: [
        {
          name: 'Old connection',
          baseUrl: 'https://old.example/v1',
          apiFormat: 'openai-responses' as const,
          models: ['Old model'],
        },
      ],
    },
  ],
}
beforeEach(() => {
  vi.mocked(readProviderRecovery).mockReset().mockResolvedValue(structuredClone(snapshot))
  vi.mocked(restoreProviderRecovery).mockReset().mockResolvedValue(undefined)
  vi.mocked(navigateTo).mockReset()
})
async function open(configurationAvailable = true) {
  render(
    <ProviderCredentialRecovery disabled={false} configurationAvailable={configurationAvailable} />
  )
  const user = userEvent.setup()
  await user.click(screen.getByTestId('provider-recovery-open'))
  await screen.findByTestId('provider-recovery-select-opaque')
  return user
}

test('recovery shows original endpoints and requires confirmation; cancellation writes nothing', async () => {
  const user = await open()
  expect(screen.getByTestId('provider-recovery-panel')).toHaveTextContent('https://old.example/v1')
  await user.click(screen.getByTestId('provider-recovery-select-opaque'))
  expect(screen.getByRole('dialog')).toHaveTextContent('https://old.example/v1')
  expect(restoreProviderRecovery).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('provider-recovery-confirm-cancel-button'))
  expect(restoreProviderRecovery).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('provider-recovery-select-opaque'))
  await user.click(screen.getByTestId('provider-recovery-confirm'))
  await screen.findByTestId('provider-recovery-success')
  expect(restoreProviderRecovery).toHaveBeenCalledExactlyOnceWith('opaque', 'protected-revision')
})

test('a failed or ambiguous restore requires fresh metadata before trying again', async () => {
  vi.mocked(restoreProviderRecovery).mockRejectedValueOnce(
    new Error('private-secret-must-not-render')
  )
  const user = await open()
  await user.click(screen.getByTestId('provider-recovery-select-opaque'))
  await user.click(screen.getByTestId('provider-recovery-confirm'))
  expect(await screen.findByTestId('provider-recovery-error')).not.toHaveTextContent(
    'private-secret'
  )
  expect(screen.queryByTestId('provider-recovery-select-opaque')).not.toBeInTheDocument()
  vi.mocked(readProviderRecovery).mockResolvedValueOnce({ ...snapshot, revision: 'new-revision' })
  await user.click(screen.getByTestId('provider-recovery-refresh'))
  await user.click(await screen.findByTestId('provider-recovery-select-opaque'))
  await user.click(screen.getByTestId('provider-recovery-confirm'))
  await screen.findByTestId('provider-recovery-success')
  expect(restoreProviderRecovery).toHaveBeenLastCalledWith('opaque', 'new-revision')
})

test('storage denial is recoverable by retry without clearing files or exposing native errors', async () => {
  vi.mocked(readProviderRecovery).mockRejectedValueOnce(new Error('vault-private-error'))
  render(<ProviderCredentialRecovery disabled={false} configurationAvailable={false} />)
  const user = userEvent.setup()
  await user.click(screen.getByTestId('provider-recovery-open'))
  const error = await screen.findByTestId('provider-recovery-error')
  expect(error).toHaveTextContent('解锁')
  expect(error).not.toHaveTextContent('vault-private-error')
  await user.click(screen.getByTestId('provider-recovery-refresh'))
  expect(await screen.findByTestId('provider-recovery-select-opaque')).toBeDisabled()
})

test('a broken current file offers snapshot recovery while legacy import stays disabled', async () => {
  vi.mocked(readProviderRecovery).mockResolvedValue({
    ...snapshot,
    candidates: [
      ...snapshot.candidates,
      { ...snapshot.candidates[0], id: 'saved', kind: 'saved-configuration' },
    ],
  })
  const user = await open(false)
  expect(screen.getByTestId('provider-recovery-select-opaque')).toBeDisabled()
  expect(screen.getByTestId('provider-recovery-select-saved')).toBeEnabled()
  await user.click(screen.getByTestId('provider-recovery-select-saved'))
  expect(screen.getByRole('dialog')).toHaveTextContent('新文件')
  await user.click(screen.getByTestId('provider-recovery-confirm'))
  expect(restoreProviderRecovery).toHaveBeenCalledWith('saved', 'protected-revision')
})

test('duplicate clicks and closing are disabled while Host publication is pending', async () => {
  let release!: () => void
  vi.mocked(restoreProviderRecovery).mockImplementation(
    () =>
      new Promise<void>(resolve => {
        release = resolve
      })
  )
  const user = await open()
  await user.click(screen.getByTestId('provider-recovery-select-opaque'))
  await user.click(screen.getByTestId('provider-recovery-confirm'))
  expect(screen.getByTestId('provider-recovery-confirm')).toBeDisabled()
  expect(screen.getByTestId('provider-recovery-close')).toBeDisabled()
  await user.click(screen.getByTestId('provider-recovery-confirm'))
  expect(restoreProviderRecovery).toHaveBeenCalledOnce()
  await act(async () => release())
  await screen.findByTestId('provider-recovery-success')
})

test('damaged archives remain visible and conflicting cloud credentials lead to reauthorization', async () => {
  vi.mocked(readProviderRecovery).mockResolvedValue({
    ...snapshot,
    unreadableArchives: 2,
    cloudConflicts: 1,
  })
  const user = await open()
  expect(screen.getByTestId('provider-recovery-panel')).toHaveTextContent('2 份归档')
  await user.click(screen.getByTestId('provider-recovery-cloud'))
  expect(navigateTo).toHaveBeenCalledWith('/settings/connections')
  expect(restoreProviderRecovery).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('provider-recovery-close'))
  await waitFor(() => expect(screen.getByTestId('provider-recovery-open')).toBeEnabled())
})

test('a metadata failure after a committed restore does not display success beside an error', async () => {
  vi.mocked(readProviderRecovery)
    .mockResolvedValueOnce(snapshot)
    .mockRejectedValueOnce(new Error('vault temporarily unavailable'))
  const user = await open()
  await user.click(screen.getByTestId('provider-recovery-select-opaque'))
  await user.click(screen.getByTestId('provider-recovery-confirm'))
  await screen.findByTestId('provider-recovery-error')
  expect(restoreProviderRecovery).toHaveBeenCalledOnce()
  expect(screen.queryByTestId('provider-recovery-success')).not.toBeInTheDocument()
  expect(screen.queryByTestId('provider-recovery-select-opaque')).not.toBeInTheDocument()
})
