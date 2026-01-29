// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react'
import { login } from '@shared/api'
import { setStorageValue } from '@shared/storage'

interface LoginFormProps {
  onSuccess: () => void
}

function LoginForm({ onSuccess }: LoginFormProps) {
  const [serverUrl, setServerUrl] = useState('http://localhost:8000')
  const [username, setUsername] = useState('')
  const [password, setpassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setError(null)

    try {
      // Save server URL first
      await setStorageValue('serverUrl', serverUrl)

      // Attempt login
      await login({
        user_name: username,
        password,
      })

      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="flex h-[520px] w-[400px] flex-col bg-base">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <svg
          className="h-6 w-6 text-primary"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
        </svg>
        <span className="text-lg font-semibold text-text-primary">Wegent</span>
      </header>

      <div className="flex flex-1 flex-col items-center justify-center px-6">
        <h2 className="mb-6 text-xl font-semibold text-text-primary">
          Sign in to Wegent
        </h2>

        <form onSubmit={handleSubmit} className="w-full space-y-4">
          {/* Server URL */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-secondary">
              Server URL
            </label>
            <input
              type="url"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="https://wegent.example.com"
              className="w-full rounded-lg border border-border bg-base px-3 py-2 text-sm text-text-primary placeholder:text-text-muted"
              required
            />
          </div>

          {/* Username */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-secondary">
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Enter your username"
              className="w-full rounded-lg border border-border bg-base px-3 py-2 text-sm text-text-primary placeholder:text-text-muted"
              required
              autoFocus
            />
          </div>

          {/* password */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-secondary">
              password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setpassword(e.target.value)}
              placeholder="Enter your password"
              className="w-full rounded-lg border border-border bg-base px-3 py-2 text-sm text-text-primary placeholder:text-text-muted"
              required
            />
          </div>

          {/* Error message */}
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
              {error}
            </div>
          )}

          {/* Submit button */}
          <button
            type="submit"
            disabled={isLoading}
            className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}

export default LoginForm
