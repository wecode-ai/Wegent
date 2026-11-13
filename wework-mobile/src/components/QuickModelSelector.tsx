import Ionicons from '@expo/vector-icons/Ionicons'
import { useRef, useState } from 'react'
import { type GestureResponderEvent, Pressable, StyleSheet, View } from 'react-native'
import { Text, useTheme } from 'react-native-paper'

import { reasoningLabel } from '@/domain/modelSelection'
import { ModelControlSurface } from './ModelControlSurface'

interface QuickModelSelectorProps {
  bottomInset?: number
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

export function QuickModelDismissLayer({ onDismiss }: QuickModelDismissLayerProps) {
  return (
    <Pressable
      accessibilityLabel="关闭模型选择"
      accessibilityRole="button"
      onPress={onDismiss}
      style={styles.dismissLayer}
      testID="quick-model-backdrop"
    />
  )
}

export function QuickModelSelector({
  bottomInset = 0,
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
  const progress = efforts.length > 1 ? selectedIndex / (efforts.length - 1) : 0
  const thumbCenter = width
    ? stylesConfig.trackInset + progress * Math.max(0, width - stylesConfig.trackInset * 2)
    : stylesConfig.trackInset

  const selectIndex = (index: number, dragging = false) => {
    const boundedIndex = Math.max(0, Math.min(efforts.length - 1, index))
    const next = efforts[boundedIndex]
    if (!next) return
    if (dragging) setDragIndex(boundedIndex)
    if (boundedIndex === selectedIndexRef.current) return
    selectedIndexRef.current = boundedIndex
    onSelectEffort(next)
  }
  const selectAt = (locationX: number) => {
    if (!efforts.length || width <= stylesConfig.trackInset * 2) return
    const ratio = Math.max(
      0,
      Math.min(1, (locationX - stylesConfig.trackInset) / (width - stylesConfig.trackInset * 2))
    )
    selectIndex(Math.round(ratio * (efforts.length - 1)), true)
  }
  const startDrag = (event: GestureResponderEvent) => {
    dragOriginX.current = event.nativeEvent.pageX - event.nativeEvent.locationX
    selectAt(event.nativeEvent.locationX)
  }

  return (
    <View
      style={[styles.surface, { paddingBottom: bottomInset + 6 }]}
      testID="quick-model-selector"
    >
      <Pressable
        accessibilityLabel={`高级模型设置，当前 ${sourceLabel} ${label} ${reasoningLabel(displayedEffort)}`}
        accessibilityRole="button"
        onPress={onOpenAdvanced}
        style={({ pressed }) => [styles.summary, pressed && styles.pressed]}
        testID="quick-model-advanced"
      >
        <Text numberOfLines={1} style={styles.label} variant="titleLarge">
          {label}
        </Text>
        {displayedEffort ? (
          <Text style={{ color: theme.colors.onSurfaceVariant }} variant="titleLarge">
            {reasoningLabel(displayedEffort)}
          </Text>
        ) : null}
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
            onLayout={event => setWidth(event.nativeEvent.layout.width)}
            onMoveShouldSetResponder={() => true}
            onResponderGrant={startDrag}
            onResponderMove={event => selectAt(event.nativeEvent.pageX - dragOriginX.current)}
            onResponderRelease={() => setDragIndex(null)}
            onResponderTerminate={() => setDragIndex(null)}
            onResponderTerminationRequest={() => false}
            onStartShouldSetResponder={() => true}
            pointerEvents="box-only"
            style={styles.trackContent}
            testID="quick-reasoning-slider"
          >
            {width ? (
              <View
                style={[
                  styles.fill,
                  {
                    width: Math.max(
                      stylesConfig.thumbSize,
                      thumbCenter + stylesConfig.thumbSize / 2 - stylesConfig.fillInset
                    ),
                  },
                ]}
              />
            ) : null}
            <View style={styles.dots}>
              {efforts.map((value, index) => (
                <View
                  key={value}
                  style={[
                    styles.dot,
                    {
                      backgroundColor:
                        index <= selectedIndex
                          ? 'rgba(255,255,255,0.22)'
                          : theme.colors.onSurfaceVariant,
                    },
                  ]}
                />
              ))}
            </View>
            {width ? (
              <View
                style={[
                  styles.thumb,
                  {
                    left: thumbCenter - stylesConfig.thumbSize / 2,
                  },
                ]}
              />
            ) : null}
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
    </View>
  )
}

const stylesConfig = {
  fillInset: 12,
  thumbSize: 40,
  trackInset: 36,
} as const

const styles = StyleSheet.create({
  dismissLayer: { position: 'absolute', inset: 0 },
  surface: {
    paddingHorizontal: 28,
  },
  summary: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  label: { flexShrink: 1, fontWeight: '500' },
  track: {
    height: 72,
    borderRadius: 36,
    overflow: 'hidden',
  },
  trackContent: {
    flex: 1,
    justifyContent: 'center',
  },
  unavailableTrack: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.62,
  },
  fill: {
    position: 'absolute',
    left: stylesConfig.fillInset,
    top: stylesConfig.fillInset,
    bottom: stylesConfig.fillInset,
    borderRadius: 28,
    backgroundColor: '#008cff',
  },
  dots: {
    paddingHorizontal: 30,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dot: { width: 12, height: 12, borderRadius: 6, opacity: 0.72 },
  thumb: {
    position: 'absolute',
    top: 16,
    width: stylesConfig.thumbSize,
    height: stylesConfig.thumbSize,
    borderRadius: stylesConfig.thumbSize / 2,
    backgroundColor: '#ffffff',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 3,
  },
  pressed: { opacity: 0.55 },
})
