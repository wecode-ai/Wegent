import type { User } from '@/types/api'
import type { HttpClient } from './http'

export function getToken(): string | null {
  return localStorage.getItem('auth_token')
}

export function removeToken() {
  localStorage.removeItem('auth_token')
  localStorage.removeItem('auth_token_expire')
}

export function createAuthApi(client: HttpClient) {
  return {
    getCurrentUser(): Promise<User> {
      return client.get('/users/me')
    },
  }
}
