import { parseWeworkScheme } from './scheme'

export const WEWORK_OPEN_SCHEME_EVENT = 'wework-open-scheme'

export function openWeworkScheme(url: string): boolean {
  if (!parseWeworkScheme(url)) return false
  window.dispatchEvent(new CustomEvent(WEWORK_OPEN_SCHEME_EVENT, { detail: url }))
  return true
}
