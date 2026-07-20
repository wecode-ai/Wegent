import type { AppearanceConfig, ResolvedAppearanceMode, WorkbenchBackgroundConfig } from './types'

export function getWorkbenchBackground(
  appearance: AppearanceConfig,
  resolvedMode: ResolvedAppearanceMode
): WorkbenchBackgroundConfig {
  if (appearance.separateBackgroundsByTheme) {
    const background =
      resolvedMode === 'dark' ? appearance.darkBackground : appearance.lightBackground
    return {
      ...background,
      imagePath: background.imagePath ?? appearance.backgroundImagePath,
    }
  }
  return {
    imagePath: appearance.backgroundImagePath,
    visibility: appearance.backgroundVisibility,
    blur: appearance.backgroundBlur,
    inMain: appearance.backgroundInMain,
    inSidebar: appearance.backgroundInSidebar,
    inTopBar: appearance.backgroundInTopBar,
  }
}
