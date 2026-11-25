import Ionicons from '@expo/vector-icons/Ionicons'
import { BlurView } from 'expo-blur'
import * as Haptics from 'expo-haptics'
import { useEffect, useRef, useState } from 'react'
import { Platform, Pressable, StyleSheet, View, type GestureResponderEvent } from 'react-native'
import { Text, useTheme } from 'react-native-paper'
import Animated, {
  FadeInDown,
  FadeOut,
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated'

import { reasoningLabel } from '@/domain/modelSelection'
import { ModelControlSurface } from './ModelControlSurface'

interface QuickModelSelectorProps {
  effort: string | undefined
  efforts: string[]
  label: string
  sourceLabel: string
  onOpenAdvanced: () => void
  onSelectEffort: (effort: string) => void
}

interface QuickModelDismissLayerProps {
  onDismiss: () => void
}

const trackHeight = 64
const thumbSize = 44
const trackInset = 32
const fillInset = 8
const dotSize = 10
const springConfig = { damping: 20, stiffness: 240, mass: 0.8 }

export function QuickModelDismissLayer({ onDismiss }: QuickModelDismissLayerProps) {
  const theme = useTheme()
  return (
    <Animated.View
      entering={FadeInDown.duration(160)}
      exiting={FadeOut.duration(120)}
      style={styles.dismissLayer}
    >
      <BlurView
        intensity={26}
        tint={theme.dark ? 'dark' : 'light'}
        {...(Platform.OS === 'android'
          ? { experimentalBlurMethod: 'dimezisBlurView' as const }
          : {})}
        style={StyleSheet.absoluteFill}
      />
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: theme.dark ? 'rgba(0,0,0,0.24)' : 'rgba(0,0,0,0.06)' },
        ]}
      />
      <Pressable
        accessibilityLabel="关闭模型选择"
        accessibilityRole="button"
        onPress={onDismiss}
        style={StyleSheet.absoluteFill}
        testID="quick-model-backdrop"
      />
    </Animated.View>
  )
}

export function QuickModelSelector({
  effort,
  efforts,
  label,
  sourceLabel,
  onOpenAdvanced,
  onSelectEffort,
}: QuickModelSelectorProps) {
  const theme = useTheme()
  const [width, setWidth] = useState(0)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const dragOriginX = useRef(0)
  const selectedIndex = dragIndex ?? Math.max(0, efforts.indexOf(effort ?? ''))
  const displayedEffort = efforts[selectedIndex] ?? effort
  const selectedIndexRef = useRef(selectedIndex)
  selectedIndexRef.current = selectedIndex
  const effortsKey = efforts.join('|')
  const visualSteps = efforts.length
  const progress = useSharedValue(efforts.length > 1 ? selectedIndex / (efforts.length - 1) : 0)
  const trackWidth = useSharedValue(0)
  const thumbX = useDerivedValue(
    () => trackInset + progress.value * Math.max(0, trackWidth.value - trackInset * 2)
  )
  const fillWidth = useDerivedValue(() =>
    progress.value <= 0.001 ? 0 : Math.max(0, thumbX.value + thumbSize / 2 - fillInset)
  )
  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: thumbX.value - thumbSize / 2 }],
  }))
  const fillStyle = useAnimatedStyle(() => ({ width: fillWidth.value }))

  useEffect(() => {
    if (dragIndex !== null) return
    const index = Math.max(0, efforts.indexOf(effort ?? ''))
    progress.value = withSpring(efforts.length > 1 ? index / (efforts.length - 1) : 0, springConfig)
  }, [dragIndex, effort, effortsKey, progress])

  const selectIndex = (index: number, dragging = false) => {
    const boundedIndex = Math.max(0, Math.min(efforts.length - 1, index))
    const next = efforts[boundedIndex]
    if (!next) return
    if (dragging) setDragIndex(boundedIndex)
    if (boundedIndex === selectedIndexRef.current) return
    selectedIndexRef.current = boundedIndex
    onSelectEffort(next)
    void Haptics.selectionAsync().catch(() => undefined)
    if (!dragging) {
      progress.value = withSpring(
        efforts.length > 1 ? boundedIndex / (efforts.length - 1) : 0,
        springConfig
      )
    }
  }

  const selectAt = (locationX: number, dragging = true) => {
    if (!efforts.length || width <= trackInset * 2) return
    const ratio = Math.max(0, Math.min(1, (locationX - trackInset) / (width - trackInset * 2)))
    progress.value = dragging ? ratio : withSpring(ratio, springConfig)
    selectIndex(Math.round(ratio * (efforts.length - 1)), dragging)
  }

  const startDrag = (event: GestureResponderEvent) => {
    dragOriginX.current = event.nativeEvent.pageX - event.nativeEvent.locationX
    setDragIndex(selectedIndexRef.current)
    selectAt(event.nativeEvent.locationX, true)
  }

  const moveDrag = (event: GestureResponderEvent) => {
    selectAt(event.nativeEvent.pageX - dragOriginX.current, true)
  }

  const endDrag = () => {
    const boundedIndex = Math.max(
      0,
      Math.min(efforts.length - 1, Math.round(progress.value * (efforts.length - 1)))
    )
    selectIndex(boundedIndex, false)
    progress.value = withSpring(
      efforts.length > 1 ? boundedIndex / (efforts.length - 1) : 0,
      springConfig
    )
    setDragIndex(null)
  }

  return (
    <Animated.View
      entering={FadeInDown.duration(180)}
      exiting={FadeOut.duration(120)}
      style={styles.container}
      testID="quick-model-selector"
    >
      <Pressable
        accessibilityLabel={`高级模型设置，当前 ${sourceLabel} ${label} ${reasoningLabel(displayedEffort)}`}
        accessibilityRole="button"
        onPress={onOpenAdvanced}
        style={({ pressed }) => [styles.summaryButton, pressed && styles.pressed]}
        testID="quick-model-advanced"
      >
        <Text
          numberOfLines={1}
          style={[styles.modelLabel, { color: theme.colors.onSurface }]}
          testID="quick-model-name"
          variant="titleLarge"
        >
          {label}
        </Text>
        <Text
          style={[styles.effortLabel, { color: theme.colors.onSurfaceVariant }]}
          testID="quick-model-effort"
          variant="titleLarge"
        >
          {reasoningLabel(displayedEffort)}
        </Text>
        <Ionicons color={theme.colors.onSurfaceVariant} name="chevron-forward" size={20} />
      </Pressable>
      <ModelControlSurface style={styles.track} testID="quick-model-track">
        {efforts.length ? (
          <View
            accessible
            accessibilityActions={[
              { name: 'increment', label: '提高智能等级' },
              { name: 'decrement', label: '降低智能等级' },
            ]}
            accessibilityLabel="智能等级"
            accessibilityRole="adjustable"
            accessibilityValue={{
              min: 1,
              max: efforts.length,
              now: selectedIndex + 1,
              text: reasoningLabel(efforts[selectedIndex]),
            }}
            onAccessibilityAction={event =>
              selectIndex(selectedIndex + (event.nativeEvent.actionName === 'increment' ? 1 : -1))
            }
            onLayout={event => {
              const nextWidth = event.nativeEvent.layout.width
              setWidth(nextWidth)
              trackWidth.value = nextWidth
            }}
            onMoveShouldSetResponder={() => true}
            onResponderGrant={startDrag}
            onResponderMove={moveDrag}
            onResponderRelease={endDrag}
            onResponderTerminate={endDrag}
            onResponderTerminationRequest={() => false}
            onStartShouldSetResponder={() => true}
            pointerEvents="box-only"
            style={styles.trackContent}
            testID="quick-reasoning-slider"
          >
            <Animated.View style={[styles.fill, fillStyle]} />
            <View style={styles.dots}>
              {Array.from({ length: visualSteps }, (_, index) => (
                <SliderDot
                  activeColor="rgba(255,255,255,0.42)"
                  count={visualSteps}
                  inactiveColor={theme.dark ? '#8e8e93' : '#b0b0b5'}
                  index={index}
                  key={index}
                  progress={progress}
                />
              ))}
            </View>
            {width ? <Animated.View style={[styles.thumb, thumbStyle]} /> : null}
          </View>
        ) : (
          <View
            accessibilityLabel="当前模型没有智能档位"
            accessibilityRole="text"
            style={styles.unavailableTrack}
            testID="quick-reasoning-unavailable"
          >
            <Text style={{ color: theme.colors.onSurfaceVariant }} variant="bodyLarge">
              当前模型没有智能档位
            </Text>
          </View>
        )}
      </ModelControlSurface>
    </Animated.View>
  )
}

function SliderDot({
  activeColor,
  count,
  inactiveColor,
  index,
  progress,
}: {
  activeColor: string
  count: number
  inactiveColor: string
  index: number
  progress: { value: number }
}) {
  const dotStyle = useAnimatedStyle(() => {
    const position = progress.value * Math.max(0, count - 1)
    const active = Math.max(0, Math.min(1, position - index + 0.5))
    return {
      backgroundColor: interpolateColor(active, [0, 1], [inactiveColor, activeColor]),
      opacity: interpolate(active, [0, 1], [0.9, 1]),
      transform: [{ scale: interpolate(active, [0, 1], [1, 1.08]) }],
    }
  })
  return <Animated.View style={[styles.dot, dotStyle]} testID={`quick-visual-dot-${index}`} />
}

const styles = StyleSheet.create({
  dismissLayer: { position: 'absolute', inset: 0 },
  container: { paddingHorizontal: 24, paddingBottom: 24 },
  summaryButton: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    maxWidth: '100%',
    minHeight: 44,
    marginBottom: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  modelLabel: {
    flexShrink: 1,
    fontWeight: '600',
    textAlign: 'center',
  },
  effortLabel: { flexShrink: 0 },
  pressed: { opacity: 0.55, transform: [{ scale: 0.98 }] },
  track: {
    height: trackHeight,
    borderRadius: trackHeight / 2,
    borderWidth: 1,
    borderColor: 'rgba(60,60,67,0.12)',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 18,
    overflow: 'hidden',
  },
  trackContent: { flex: 1, justifyContent: 'center' },
  unavailableTrack: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.62,
  },
  fill: {
    position: 'absolute',
    left: fillInset,
    top: fillInset,
    bottom: fillInset,
    borderRadius: (trackHeight - fillInset * 2) / 2,
    backgroundColor: '#008cff',
  },
  dots: {
    paddingHorizontal: trackInset - dotSize / 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dot: { width: dotSize, height: dotSize, borderRadius: dotSize / 2 },
  thumb: {
    position: 'absolute',
    top: (trackHeight - thumbSize) / 2,
    width: thumbSize,
    height: thumbSize,
    borderRadius: thumbSize / 2,
    borderWidth: 3,
    borderColor: '#008cff',
    backgroundColor: '#ffffff',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.16,
    shadowRadius: 6,
  },
})
