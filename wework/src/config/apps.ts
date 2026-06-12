export interface AppTab {
  key: string
  label: string
  mode: 'native' | 'iframe'
  url?: string
  requiresAuth?: boolean
  hidden?: boolean
}

export const APP_TABS: AppTab[] = [
  { key: 'wework', label: 'WeWork', mode: 'native', requiresAuth: true },
  {
    key: 'wegent',
    label: 'Wegent',
    mode: 'iframe',
    url: import.meta.env.VITE_WEGENT_URL || 'http://localhost:3000',
    requiresAuth: true,
    hidden: true,
  },
]

export const DEFAULT_APP_KEY = 'wework'
