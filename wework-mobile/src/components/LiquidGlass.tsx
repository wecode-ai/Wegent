import {
  GlassContainer,
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
  type GlassColorScheme,
  type GlassEffectStyleConfig,
} from 'expo-glass-effect'
import type { ReactNode } from 'react'
import {
  Platform,
  Pressable,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native'

export const liquidGlassAccentTint = 'rgba(38, 137, 235, 0.68)'
export const liquidGlassAccentBorder = 'rgba(92, 169, 238, 0.78)'

const nativeLiquidGlassAvailable =
  Platform.OS === 'ios' && isLiquidGlassAvailable() && isGlassEffectAPIAvailable()

interface LiquidGlassGroupProps {
  children: ReactNode
  onLayout?: (event: LayoutChangeEvent) => void
  spacing: number
  style: StyleProp<ViewStyle>
  testID?: string
}

export function LiquidGlassGroup({
  children,
  onLayout,
  spacing,
  style,
  testID,
}: LiquidGlassGroupProps) {
  if (nativeLiquidGlassAvailable) {
    return (
      <GlassContainer onLayout={onLayout} spacing={spacing} style={style} testID={testID}>
        {children}
      </GlassContainer>
    )
  }

  return (
    <View onLayout={onLayout} style={style} testID={testID}>
      {children}
    </View>
  )
}

interface LiquidGlassSurfaceProps {
  children: ReactNode
  colorScheme: GlassColorScheme
  fallbackStyle: StyleProp<ViewStyle>
  glassEffectStyle?: GlassEffectStyleConfig | 'clear' | 'regular'
  isInteractive?: boolean
  onLayout?: (event: LayoutChangeEvent) => void
  style: StyleProp<ViewStyle>
  testID?: string
  tintColor?: string
}

export function LiquidGlassSurface({
  children,
  colorScheme,
  fallbackStyle,
  glassEffectStyle = 'regular',
  isInteractive = true,
  onLayout,
  style,
  testID,
  tintColor,
}: LiquidGlassSurfaceProps) {
  if (nativeLiquidGlassAvailable) {
    return (
      <GlassView
        colorScheme={colorScheme}
        glassEffectStyle={glassEffectStyle}
        isInteractive={isInteractive}
        onLayout={onLayout}
        style={style}
        testID={testID}
        tintColor={tintColor}
      >
        {children}
      </GlassView>
    )
  }

  return (
    <View
      onLayout={onLayout}
      style={[style, styles.fallbackSurface, fallbackStyle]}
      testID={testID}
    >
      {children}
    </View>
  )
}

interface LiquidGlassButtonProps {
  accessibilityLabel?: string
  children: ReactNode
  colorScheme: GlassColorScheme
  contentStyle: StyleProp<ViewStyle>
  disabled?: boolean
  fallbackStyle: StyleProp<ViewStyle>
  glassEffectStyle?: GlassEffectStyleConfig | 'clear' | 'regular'
  hitSlop?: PressableProps['hitSlop']
  onPress: NonNullable<PressableProps['onPress']>
  style: StyleProp<ViewStyle>
  testID?: string
  tintColor?: string
}

export function LiquidGlassButton({
  accessibilityLabel,
  children,
  colorScheme,
  contentStyle,
  disabled = false,
  fallbackStyle,
  glassEffectStyle = 'regular',
  hitSlop,
  onPress,
  style,
  testID,
  tintColor,
}: LiquidGlassButtonProps) {
  return (
    <LiquidGlassSurface
      colorScheme={colorScheme}
      fallbackStyle={fallbackStyle}
      glassEffectStyle={glassEffectStyle}
      isInteractive={!disabled}
      style={style}
      tintColor={tintColor}
    >
      <Pressable
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        hitSlop={hitSlop}
        onPress={onPress}
        style={({ pressed }) => [contentStyle, pressed && styles.buttonPressed]}
        testID={testID}
      >
        {children}
      </Pressable>
    </LiquidGlassSurface>
  )
}

const styles = StyleSheet.create({
  fallbackSurface: { borderWidth: StyleSheet.hairlineWidth },
  buttonPressed: { transform: [{ scale: 0.96 }] },
})
