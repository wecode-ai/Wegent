import type { User, UserPreferences } from '@/types/api'
import type { HttpClient } from './http'

export interface UpdateCurrentUserRequest {
  preferences?: UserPreferences
}

export function createUserApi(client: HttpClient) {
  return {
    updateCurrentUser(data: UpdateCurrentUserRequest): Promise<User> {
      return client.put('/users/me', data)
    },
  }
}
