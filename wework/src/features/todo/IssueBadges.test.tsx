import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { AppPreferencesContext } from '@/features/app-preferences/appPreferencesContext'
import { defaultAppPreferences } from '@/desktop/appPreferences'
import { IssueBadges } from './IssueBadges'

const openExternalUrl = vi.hoisted(() => vi.fn())
vi.mock('@/lib/external-links', () => ({ openExternalUrl }))
afterEach(() => localStorage.clear())
const url = 'https://github.com/acme/app/pull/42'
const badges = [{ id: url, label: '#42', url, icon: 'git-pull-request' }]

describe('IssueBadges', () => {
  it('renders business-independent badges without a device connection', () => {
    render(
      <IssueBadges
        badges={[
          {
            id: 'review',
            label: 'Reviewed',
            tone: 'success',
            icon: 'check',
            tooltip: 'Approved by reviewer',
          },
        ]}
        compact
      />
    )
    expect(screen.getByText('Reviewed')).toBeVisible()
    expect(screen.getByTitle('Approved by reviewer')).toHaveClass('text-green-600')
  })

  it('enriches linked badges and keeps the compact card label short', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      success: true,
      stdout: { number: 42, url, title: 'Fix', state: 'MERGED' },
    })
    const view = render(<IssueBadges api={{ executeCommand }} badges={badges} compact />)
    await waitFor(() =>
      expect(screen.getByTestId('issue-pr-status-github-42')).toHaveAccessibleName(/42/)
    )
    expect(screen.getByTestId('issue-pr-github-42')).toHaveTextContent('#42')
    expect(screen.getByTestId('issue-pr-github-42')).not.toHaveTextContent('acme/app')
    view.rerender(<IssueBadges badges={[]} />)
    expect(screen.queryByTestId('issue-badges')).not.toBeInTheDocument()
  })

  it('keeps generic links visible when status lookup is disabled', () => {
    const executeCommand = vi.fn()
    render(
      <AppPreferencesContext.Provider
        value={{
          loaded: true,
          preferences: { ...defaultAppPreferences, changeRequestStatusEnabled: false },
        }}
      >
        <IssueBadges api={{ executeCommand }} badges={badges} />
      </AppPreferencesContext.Provider>
    )
    fireEvent.click(screen.getByRole('button', { name: '#42' }))
    expect(openExternalUrl).toHaveBeenCalledWith(url)
    expect(executeCommand).not.toHaveBeenCalled()
  })
})
