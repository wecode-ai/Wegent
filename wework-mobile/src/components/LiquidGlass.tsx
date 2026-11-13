import {
  GlassContainer,
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
  type GlassColorScheme,
  type GlassEffectStyleConfig,
} from 'expo-glass-effect'
import { useSyncExternalStore, type ReactNode } from 'react'
import {
  AccessibilityInfo,
  Appearance,
  Platform,
  Pressable,
  processColor,
  StyleSheet,
  View,
  type ColorValue,
  type LayoutChangeEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native'

export const liquidGlassAccentTint = 'rgba(38, 137, 235, 0.68)'
export const liquidGlassAccentBorder = 'rgba(92, 169, 238, 0.78)'

function nativeLiquidGlassAvailable(): boolean {
  return Platform.OS === 'ios' && isLiquidGlassAvailable() && isGlassEffectAPIAvailable()
}

let reducedTransparency = false
const transparencyListeners = new Set<() => void>()
let transparencySubscription: ReturnType<typeof AccessibilityInfo.addEventListener> | null = null
let transparencyRevision = 0

function updateReducedTransparency(value: boolean) {
  transparencyRevision += 1
  if (reducedTransparency === value) return
  reducedTransparency = value
  transparencyListeners.forEach(listener => listener())
}

function subscribeToTransparency(listener: () => void) {
  transparencyListeners.add(listener)
  if (!transparencySubscription) {
    transparencySubscription = AccessibilityInfo.addEventListener(
      'reduceTransparencyChanged',
      updateReducedTransparency
    )
    const revision = transparencyRevision
    void AccessibilityInfo.isReduceTransparencyEnabled().then(
      value => {
        if (revision === transparencyRevision) updateReducedTransparency(value)
      },
      error => {
        console.warn('Unable to read the reduced transparency setting', error)
        if (revision === transparencyRevision) updateReducedTransparency(true)
      }
    )
  }
  return () => {
    transparencyListeners.delete(listener)
    if (transparencyListeners.size) return
    transparencySubscription?.remove()
    transparencySubscription = null
    transparencyRevision += 1
  }
}

const subscribeToNoChanges = () => () => {}
const getReducedTransparency = () => reducedTransparency
const getDefaultTransparency = () => false

function useNativeGlass(): boolean {
  const available = nativeLiquidGlassAvailable()
  const reduced = useSyncExternalStore(
    available ? subscribeToTransparency : subscribeToNoChanges,
    getReducedTransparency,
    getDefaultTransparency
  )
  return available && !reduced
}

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
  if (nativeLiquidGlassAvailable()) {
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
  const nativeGlass = useNativeGlass()
  if (nativeGlass) {
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

  const dark = (colorScheme === 'auto' ? Appearance.getColorScheme() : colorScheme) === 'dark'
  const resolvedFallback = StyleSheet.flatten(fallbackStyle)
  return (
    <View
      onLayout={onLayout}
      style={[
        style,
        styles.fallbackSurface,
        dark ? styles.darkSurface : styles.lightSurface,
        resolvedFallback,
        { backgroundColor: opaqueSurfaceColor(resolvedFallback?.backgroundColor, dark) },
      ]}
      testID={testID}
    >
      {children}
    </View>
  )
}

function opaqueSurfaceColor(color: ColorValue | undefined, dark: boolean): ColorValue {
  const base = dark ? 24 : 255
  const surface = color ?? (dark ? '#202020' : '#f7f7f7')
  const processed = processColor(surface)
  if (typeof processed !== 'number') return surface
  const alpha = ((processed >>> 24) & 255) / 255
  const channel = (shift: number) =>
    Math.round(((processed >>> shift) & 255) * alpha + base * (1 - alpha))
  return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`
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
  lightSurface: { backgroundColor: '#f7f7f7', borderColor: '#e7e7e7' },
  darkSurface: { backgroundColor: '#202020', borderColor: '#2c2c2e' },
  buttonPressed: { transform: [{ scale: 0.96 }] },
})
