import { describe, expect, test } from 'vitest'
import { defaultAppearance } from './presets'
import { getWorkbenchBackground } from './backgroundTheme'

describe('getWorkbenchBackground', () => {
  test('uses the common configuration by default', () => {
    const appearance = {
      ...defaultAppearance,
      backgroundImagePath: '/backgrounds/common.png',
      backgroundBlur: 4,
    }

    expect(getWorkbenchBackground(appearance, 'light')).toMatchObject({
      imagePath: '/backgrounds/common.png',
      blur: 4,
    })
    expect(getWorkbenchBackground(appearance, 'dark')).toMatchObject({
      imagePath: '/backgrounds/common.png',
      blur: 4,
    })
  })

  test('selects the full configuration for the resolved theme', () => {
    const appearance = {
      ...defaultAppearance,
      separateBackgroundsByTheme: true,
      lightBackground: {
        ...defaultAppearance.lightBackground,
        imagePath: '/backgrounds/light.png',
        blur: 2,
      },
      darkBackground: {
        ...defaultAppearance.darkBackground,
        imagePath: '/backgrounds/dark.png',
        blur: 12,
      },
    }

    expect(getWorkbenchBackground(appearance, 'light')).toMatchObject({
      imagePath: '/backgrounds/light.png',
      blur: 2,
    })
    expect(getWorkbenchBackground(appearance, 'dark')).toMatchObject({
      imagePath: '/backgrounds/dark.png',
      blur: 12,
    })
  })
})
