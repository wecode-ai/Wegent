export interface AppTab {
  key: string
  label: string
  mode: 'native' | 'iframe'
  path?: string
  url?: string
  requiresAuth?: boolean
  hidden?: boolean
}

export const APP_TABS: AppTab[] = [
  { key: 'wework', label: 'WeWork', mode: 'native', path: '/', requiresAuth: true },
  {
    key: 'wegent',
    label: 'Wegent',
    mode: 'iframe',
    requiresAuth: true,
    hidden: true,
  },
]

export const DEFAULT_APP_KEY = 'wework'
