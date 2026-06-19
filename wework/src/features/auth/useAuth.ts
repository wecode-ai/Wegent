import { createContext, useContext } from 'react'
import type { AdminPasswordSetupStatusResponse, LoginRequest } from '@/api/auth'
import type { User } from '@/types/api'

export interface AuthContextValue {
  user: User | null
  isLoading: boolean
  login: (data: LoginRequest) => Promise<User>
  logout: () => void
  refresh: () => Promise<void>
  loginWithOidcToken: (accessToken: string) => Promise<void>
  getAdminPasswordSetupStatus: () => Promise<AdminPasswordSetupStatusResponse>
  setupAdminPassword: (password: string) => Promise<User>
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return context
}
