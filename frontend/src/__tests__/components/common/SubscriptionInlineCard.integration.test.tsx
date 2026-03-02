import '@testing-library/jest-dom'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { SubscriptionInlineCard } from '@/components/common/SubscriptionInlineCard'
import { subscriptionApis } from '@/apis/subscription'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        enabled_success: 'Enabled',
        disabled_success: 'Disabled',
        enable_subscription: 'Toggle subscription',
        edit: 'Edit',
        'feed.view_details': 'View Details',
        cron_expression: 'Cron Expression',
        timezone_hint: 'Timezone',
        interval_value: 'Interval',
        interval_unit: 'Unit',
        unit_minutes: 'Minutes',
        unit_hours: 'Hours',
        unit_days: 'Days',
        execute_at: 'Execute At',
        'common:actions.cancel': 'Cancel',
        'common:actions.save': 'Save',
        'common:actions.saving': 'Saving...',
      }
      return translations[key] || key
    },
  }),
}))

jest.mock('@/apis/subscription', () => ({
  subscriptionApis: {
    getSubscription: jest.fn(),
    updateSubscription: jest.fn(),
  },
}))

const mockGetSubscription = subscriptionApis.getSubscription as jest.Mock
const mockUpdateSubscription = subscriptionApis.updateSubscription as jest.Mock

describe('SubscriptionInlineCard Integration', () => {
  const mockSubscription = {
    id: 123,
    display_name: 'Test Subscription',
    enabled: false,
    trigger_type: 'cron' as const,
    trigger_config: { expression: '0 9 * * *', timezone: 'Asia/Shanghai' },
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should complete enable and edit flow', async () => {
    // Initial fetch
    mockGetSubscription.mockResolvedValueOnce(mockSubscription)

    render(<SubscriptionInlineCard subscriptionId={123} />)

    // Wait for load
    await waitFor(() => {
      expect(screen.getByText('Test Subscription')).toBeInTheDocument()
    })

    // Verify trigger summary shown
    expect(screen.getByText('Cron: 0 9 * * *')).toBeInTheDocument()

    // Verify disabled state shown
    expect(screen.getByText('Disabled')).toBeInTheDocument()

    // Enable subscription
    mockUpdateSubscription.mockResolvedValueOnce({
      ...mockSubscription,
      enabled: true,
    })

    fireEvent.click(screen.getByRole('switch'))

    await waitFor(() => {
      expect(mockUpdateSubscription).toHaveBeenCalledWith(123, { enabled: true })
    })

    // Verify enabled state shown after toggle
    await waitFor(() => {
      expect(screen.getByText('Enabled')).toBeInTheDocument()
    })

    // Click edit
    fireEvent.click(screen.getByText('Edit'))

    // Should show cron editor
    await waitFor(() => {
      expect(screen.getByText('Cron Expression')).toBeInTheDocument()
    })

    // Verify cancel returns to view mode
    fireEvent.click(screen.getByText('Cancel'))

    await waitFor(() => {
      expect(screen.getByText('Test Subscription')).toBeInTheDocument()
      expect(screen.getByRole('switch')).toBeInTheDocument()
    })
  })

  it('should save edited trigger config', async () => {
    mockGetSubscription.mockResolvedValueOnce(mockSubscription)

    render(<SubscriptionInlineCard subscriptionId={123} />)

    await waitFor(() => {
      expect(screen.getByText('Test Subscription')).toBeInTheDocument()
    })

    // Enter edit mode
    fireEvent.click(screen.getByText('Edit'))

    // Modify cron expression
    const cronInput = screen.getByDisplayValue('0 9 * * *')
    fireEvent.change(cronInput, { target: { value: '0 10 * * *' } })

    // Save
    mockUpdateSubscription.mockResolvedValueOnce({
      ...mockSubscription,
      trigger_config: { expression: '0 10 * * *', timezone: 'Asia/Shanghai' },
    })

    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => {
      expect(mockUpdateSubscription).toHaveBeenCalledWith(123, {
        trigger_type: 'cron',
        trigger_config: { expression: '0 10 * * *', timezone: 'Asia/Shanghai' },
      })
    })

    // Should return to view mode
    await waitFor(() => {
      expect(screen.getByRole('switch')).toBeInTheDocument()
    })
  })

  it('should show retry on fetch error', async () => {
    mockGetSubscription.mockRejectedValueOnce(new Error('Network error'))

    render(<SubscriptionInlineCard subscriptionId={123} />)

    await waitFor(() => {
      expect(screen.getByText(/failed to load/i)).toBeInTheDocument()
    })

    // Retry should re-fetch
    mockGetSubscription.mockResolvedValueOnce(mockSubscription)

    fireEvent.click(screen.getByText('Retry'))

    await waitFor(() => {
      expect(screen.getByText('Test Subscription')).toBeInTheDocument()
    })
  })
})
