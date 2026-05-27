import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import App from './App'

describe('App auth routing', () => {
  test('renders login page on /login', () => {
    window.history.pushState({}, '', '/login')

    render(<App />)

    expect(screen.getByTestId('login-form')).toBeInTheDocument()
  })
})
