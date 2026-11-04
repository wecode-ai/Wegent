import '@/i18n'
import { render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { TelemetryCollectionNotice } from './TelemetryCollectionNotice'

afterEach(() => vi.unstubAllEnvs())

test('shows no additional collection notice with default privacy settings', () => {
  render(<TelemetryCollectionNotice />)
  expect(screen.queryByTestId('telemetry-collection-notice')).not.toBeInTheDocument()
})

test('discloses explicitly selected fields and email-prefix identity', () => {
  vi.stubEnv('VITE_WEWORK_TELEMETRY_IDENTITY', 'email_prefix')
  vi.stubEnv('VITE_WEWORK_TELEMETRY_CONTEXT_FIELDS', '["smart_app_name"]')
  render(<TelemetryCollectionNotice />)
  const notice = screen.getByTestId('telemetry-collection-notice')
  expect(notice).toHaveTextContent(/Email|邮箱/)
  expect(notice).toHaveTextContent(/App name|应用名称/)
})
