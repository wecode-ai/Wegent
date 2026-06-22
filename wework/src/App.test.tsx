import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import App from './App'

describe('App auth routing', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ required: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    )
  })

  test('renders login page on /login', async () => {
    window.history.pushState({}, '', '/login')

    render(<App />)

    expect(await screen.findByTestId('login-form')).toBeInTheDocument()
  })
})
