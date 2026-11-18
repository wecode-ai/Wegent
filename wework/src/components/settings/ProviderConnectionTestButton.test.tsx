import type { ModelProvider } from '@/features/model-settings/providerModelConfiguration'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { ProviderConnectionTestButton } from './ProviderConnectionTestButton'
import i18n from '@/i18n'
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

test.each([
  ['en', 'Failed'],
  ['zh-CN', '连接失败'],
])('localizes native connection failures in %s', async (language, message) => {
  const previous = i18n.language
  try {
    await i18n.changeLanguage(language)
    probe.mockResolvedValue([{ model: 'model', error: 'connection_test_failed' }])
    render(<ProviderConnectionTestButton provider={provider} testId="probe" />)
    fireEvent.click(screen.getByTestId('probe'))
    expect(await screen.findByRole('alert')).toHaveTextContent(`model: ${message}`)
    expect(screen.getByRole('alert')).not.toHaveTextContent('connection_test_failed')
  } finally {
    await i18n.changeLanguage(previous)
  }
})
