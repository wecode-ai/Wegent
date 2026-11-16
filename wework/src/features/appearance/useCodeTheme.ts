import { getWorkbenchCodeTheme } from '@/lib/code-theme'
import { defaultAppearance } from './presets'
import { useOptionalAppearance } from './useAppearance'

export function useCodeTheme() {
  const appearance = useOptionalAppearance()?.appearance ?? defaultAppearance
  return getWorkbenchCodeTheme(appearance.lightThemeId, appearance.darkThemeId)
}
