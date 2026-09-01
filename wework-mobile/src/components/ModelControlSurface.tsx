import type { ReactNode } from 'react'
import type { StyleProp, ViewStyle } from 'react-native'
import { useTheme } from 'react-native-paper'

import { LiquidGlassSurface } from './LiquidGlass'

interface ModelControlSurfaceProps {
  children: ReactNode
  style: StyleProp<ViewStyle>
  testID: string
}

export function ModelControlSurface({ children, style, testID }: ModelControlSurfaceProps) {
  const theme = useTheme()

  return (
    <LiquidGlassSurface
      colorScheme={theme.dark ? 'dark' : 'light'}
      fallbackStyle={{
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.outlineVariant,
      }}
      glassEffectStyle="clear"
      isInteractive={false}
      style={style}
      testID={testID}
      tintColor={theme.dark ? '#111111' : '#f4f4f4'}
    >
      {children}
    </LiquidGlassSurface>
  )
}
