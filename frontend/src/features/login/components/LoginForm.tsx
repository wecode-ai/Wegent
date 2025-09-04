// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline'
import { Button } from '@headlessui/react'
import { useRouter } from 'next/navigation'
import { useUser } from '@/features/common/UserContext'
import { paths } from '@/config/paths'

export default function LoginForm() {
  const router = useRouter()
  const [formData, setFormData] = useState({
    user_name: 'admin',
    password: 'admin'
  })
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target
    setFormData(prev => ({
      ...prev,
      [name]: value
    }))
    if (error) setError('')
  }

  const { user, refresh, isLoading: userLoading, login } = useUser()
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (user) {
      router.replace(paths.task.getHref())
      return
    }
    setIsLoading(true)
    setError('')

    try {
      await login({
        user_name: formData.user_name,
        password: formData.password
      })
      router.replace(paths.task.getHref())
    } catch (error: any) {
      setError(error.message || 'Login failed, please check username and password')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <form className="space-y-6" onSubmit={handleSubmit}>
      <div>
        <label htmlFor="user_name" className="block text-sm font-medium text-gray-300">
          Username
        </label>
        <div className="mt-1">
          <input
            id="user_name"
            name="user_name"
            type="text"
            autoComplete="username"
            required
            value={formData.user_name}
            onChange={handleInputChange}
            className="appearance-none block w-full px-3 py-2 border border-[#30363d] rounded-md shadow-sm bg-[#0d1117] text-white placeholder-gray-500 focus:outline-none focus:outline-white/25 focus:border-transparent sm:text-sm"
            placeholder="Enter username"
          />
        </div>
      </div>

      <div>
        <label htmlFor="password" className="block text-sm font-medium text-gray-300">
          password
        </label>
        <div className="mt-1 relative">
          <input
            id="password"
            name="password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            required
            value={formData.password}
            onChange={handleInputChange}
            className="appearance-none block w-full px-3 py-2 pr-10 border border-[#30363d] rounded-md shadow-sm bg-[#0d1117] text-white placeholder-gray-500 focus:outline-none focus:outline-white/25 focus:border-transparent sm:text-sm"
            placeholder="Enter password"
          />
          <button
            type="button"
            className="absolute inset-y-0 right-0 pr-3 flex items-center"
            onClick={() => setShowPassword(!showPassword)}
          >
            {showPassword ? (
              <EyeSlashIcon className="h-5 w-5 text-gray-400 hover:text-gray-300" />
            ) : (
              <EyeIcon className="h-5 w-5 text-gray-400 hover:text-gray-300" />
            )}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-red-900/20 border border-red-800/50 p-3">
          <div className="text-sm text-red-300">{error}</div>
        </div>
      )}

      <div>
        <Button
          type="submit"
          disabled={isLoading}
          className="w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white focus:outline-none focus:outline-white/25 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200"
          style={{ backgroundColor: 'rgb(112,167,215)' }}
        >
          {isLoading ? (
            <div className="flex items-center">
              <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Logging in...
            </div>
          ) : (
            'Login'
          )}
        </Button>
      </div>

      <div className="mt-6">
        <div className="text-center text-xs text-gray-500">
          Test account: admin / admin
        </div>
      </div>
    </form>
  )
}