import type { ModelProvider } from '@/features/model-settings/providerModelConfiguration'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { ProviderConnectionTestButton } from './ProviderConnectionTestButton'
const { probe } = vi.hoisted(() => ({ probe: vi.fn() }))
vi.mock('@/features/model-settings/providerConnectionTest', () => ({
  testProviderConnection: probe,
}))
const provider: ModelProvider = {
  id: 'p',
  name: 'Provider',
  base_url: 'https://example.com/v1',
  api_format: 'openai-responses',
  models: [{ id: 'm', model_id: 'model' }],
}
beforeEach(() => vi.resetAllMocks())
test('requires a model and displays connection errors with retry', async () => {
  const { rerender } = render(
    <ProviderConnectionTestButton provider={{ ...provider, models: [] }} testId="probe" />
  )
  expect(screen.getByTestId('probe')).toBeDisabled()
  rerender(<ProviderConnectionTestButton provider={provider} testId="probe" />)
  probe
    .mockResolvedValueOnce([{ model: 'model', error: 'HTTP 401: bad key' }])
    .mockResolvedValueOnce([{ model: 'model' }])
  fireEvent.click(screen.getByTestId('probe'))
  expect(await screen.findByRole('alert')).toHaveTextContent('model: HTTP 401: bad key')
  expect(screen.getByRole('alert')).not.toHaveAttribute('open')
  fireEvent.click(screen.getByTestId('probe-error-details'))
  expect(screen.getByRole('alert')).toHaveAttribute('open')
  fireEvent.click(screen.getByTestId('probe'))
  expect(await screen.findByRole('status')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).toBeNull()
})

test('returning to a configuration does not retain an abandoned probe or its result', async () => {
  let finish!: (value: Array<{ model: string; error?: string }>) => void
  const pending = new Promise<Array<{ model: string; error?: string }>>(resolve => {
    finish = resolve
  })
  probe.mockReturnValueOnce(pending)
  const view = render(<ProviderConnectionTestButton provider={provider} testId="probe" />)
  fireEvent.click(screen.getByTestId('probe'))
  view.rerender(
    <ProviderConnectionTestButton
      provider={{ ...provider, base_url: 'https://other.example/v1' }}
      testId="probe"
    />
  )
  view.rerender(<ProviderConnectionTestButton provider={provider} testId="probe" />)
  await act(async () => finish([{ model: 'model', error: 'previous probe failure' }]))
  expect(screen.getByTestId('probe')).toBeEnabled()
  expect(screen.queryByRole('alert')).toBeNull()
  probe.mockResolvedValueOnce([{ model: 'model' }])
  fireEvent.click(screen.getByTestId('probe'))
  expect(await screen.findByRole('status')).toBeInTheDocument()
  expect(probe).toHaveBeenCalledTimes(2)
})

test('does not start duplicate connection probes in a single event batch', async () => {
  let finish!: (value: Array<{ model: string }>) => void
  probe.mockReturnValueOnce(
    new Promise<Array<{ model: string }>>(resolve => {
      finish = resolve
    })
  )
  render(<ProviderConnectionTestButton provider={provider} testId="probe" />)
  act(() => {
    fireEvent.click(screen.getByTestId('probe'))
    fireEvent.click(screen.getByTestId('probe'))
  })
  expect(probe).toHaveBeenCalledOnce()
  await act(async () => finish([{ model: 'model' }]))
})

test('keeps an active probe when the same configuration is passed as a new object', async () => {
  let finish!: (value: Array<{ model: string }>) => void
  probe.mockReturnValueOnce(
    new Promise<Array<{ model: string }>>(resolve => {
      finish = resolve
    })
  )
  const view = render(<ProviderConnectionTestButton provider={provider} testId="probe" />)
  fireEvent.click(screen.getByTestId('probe'))
  view.rerender(
    <ProviderConnectionTestButton
      provider={{ ...provider, models: provider.models.map(model => ({ ...model })) }}
      testId="probe"
    />
  )
  expect(screen.getByTestId('probe')).toBeDisabled()
  await act(async () => finish([{ model: 'model' }]))
  expect(await screen.findByRole('status')).toBeInTheDocument()
  expect(probe).toHaveBeenCalledOnce()
})

test('shows a rejected connection request and allows an explicit retry', async () => {
  probe
    .mockRejectedValueOnce(new Error('transport unavailable'))
    .mockResolvedValueOnce([{ model: 'model' }])
  render(<ProviderConnectionTestButton provider={provider} testId="probe" />)
  fireEvent.click(screen.getByTestId('probe'))
  expect(await screen.findByRole('alert')).toHaveTextContent('transport unavailable')
  expect(screen.getByTestId('probe')).toBeEnabled()
  fireEvent.click(screen.getByTestId('probe'))
  expect(await screen.findByRole('status')).toBeInTheDocument()
  expect(probe).toHaveBeenCalledTimes(2)
})
