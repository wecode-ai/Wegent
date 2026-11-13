import type { ReactNode } from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { useTheme } from 'react-native-paper'

import { LiquidGlassSurface } from './LiquidGlass'

interface ModelControlSurfaceProps {
  children: ReactNode
  showBackground?: boolean
  style: StyleProp<ViewStyle>
  testID: string
}

export function ModelControlSurface({
  children,
  showBackground = true,
  style,
  testID,
}: ModelControlSurfaceProps) {
  const theme = useTheme()
  const shape = StyleSheet.flatten(style)

  return (
    <View style={style} testID={testID}>
      {showBackground ? (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <LiquidGlassSurface
            colorScheme={theme.dark ? 'dark' : 'light'}
            fallbackStyle={{
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.outlineVariant,
            }}
            glassEffectStyle="regular"
            isInteractive={false}
            style={[StyleSheet.absoluteFill, { borderRadius: shape?.borderRadius }]}
          >
            {null}
          </LiquidGlassSurface>
        </View>
      ) : null}
      {children}
    </View>
  )
}
