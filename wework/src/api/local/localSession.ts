import type { User } from '@/types/api'

export const LOCAL_USER = {
  id: 0,
  user_name: 'local',
  email: 'local@wework.local',
  preferences: {},
} satisfies User

export function getLocalUser(): User {
  return LOCAL_USER
}
