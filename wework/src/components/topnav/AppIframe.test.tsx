import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { AppIframe } from './AppIframe'

describe('AppIframe', () => {
  test('renders iframe with src and title', () => {
    render(<AppIframe src="http://localhost:3000" title="Wegent" />)
    const iframe = screen.getByTestId('app-iframe-wegent')
    expect(iframe).toBeInTheDocument()
    expect(iframe).toHaveAttribute('src', 'http://localhost:3000')
    expect(iframe).toHaveAttribute('title', 'Wegent')
  })

  test('shows loading spinner initially', () => {
    render(<AppIframe src="http://localhost:3000" title="Wegent" />)
    expect(screen.getByText('Loading Wegent...')).toBeInTheDocument()
  })

  test('hides loading on iframe load', () => {
    render(<AppIframe src="http://localhost:3000" title="Wegent" />)
    const iframe = screen.getByTestId('app-iframe-wegent')
    fireEvent.load(iframe)
    expect(screen.queryByText('Loading Wegent...')).not.toBeInTheDocument()
  })

  test('has sandbox attribute for security', () => {
    render(<AppIframe src="http://localhost:3000" title="Wegent" />)
    const iframe = screen.getByTestId('app-iframe-wegent')
    expect(iframe).toHaveAttribute('sandbox')
  })

  test('allows popup links to escape the iframe sandbox', () => {
    render(<AppIframe src="http://localhost:3000" title="Wegent" />)
    const iframe = screen.getByTestId('app-iframe-wegent')
    expect(iframe).toHaveAttribute(
      'sandbox',
      expect.stringContaining('allow-popups-to-escape-sandbox')
    )
  })
})
