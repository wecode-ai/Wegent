import Ionicons from '@expo/vector-icons/Ionicons'
import { useRef, useState } from 'react'
import { type GestureResponderEvent, Pressable, StyleSheet, View } from 'react-native'
import { Text, useTheme } from 'react-native-paper'

import { reasoningLabel } from '@/domain/modelSelection'
import { LiquidGlassSurface } from './LiquidGlass'
import { ModelControlSurface } from './ModelControlSurface'

interface QuickModelSelectorProps {
  bottomInset?: number
  effort: string | undefined
  efforts: string[]
  label: string
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
  onOpenAdvanced,
  onSelectEffort,
}: QuickModelSelectorProps) {
  const theme = useTheme()
  const [width, setWidth] = useState(0)
  const selectedIndex = Math.max(0, efforts.indexOf(effort ?? ''))
  const selectedIndexRef = useRef(selectedIndex)
  selectedIndexRef.current = selectedIndex
  const progress = efforts.length > 1 ? selectedIndex / (efforts.length - 1) : 0
  const thumbCenter = width
    ? stylesConfig.trackInset + progress * Math.max(0, width - stylesConfig.trackInset * 2)
    : stylesConfig.trackInset

  const selectIndex = (index: number) => {
    const boundedIndex = Math.max(0, Math.min(efforts.length - 1, index))
    const next = efforts[boundedIndex]
    if (!next || boundedIndex === selectedIndexRef.current) return
    selectedIndexRef.current = boundedIndex
    onSelectEffort(next)
  }
  const selectAt = (event: GestureResponderEvent) => {
    if (!efforts.length || width <= stylesConfig.trackInset * 2) return
    const ratio = Math.max(
      0,
      Math.min(
        1,
        (event.nativeEvent.locationX - stylesConfig.trackInset) /
          (width - stylesConfig.trackInset * 2)
      )
    )
    selectIndex(Math.round(ratio * (efforts.length - 1)))
  }

  return (
    <ModelControlSurface
      style={[styles.surface, { paddingBottom: bottomInset + 6 }]}
      testID="quick-model-selector"
    >
      <Pressable
        accessibilityLabel={'高级模型设置，当前' + label}
        accessibilityRole="button"
        onPress={onOpenAdvanced}
        style={({ pressed }) => [styles.summary, pressed && styles.pressed]}
        testID="quick-model-advanced"
      >
        <Text numberOfLines={1} style={styles.label} variant="headlineSmall">
          {label}
        </Text>
        <Ionicons color={theme.colors.onSurfaceVariant} name="chevron-forward" size={24} />
      </Pressable>
      <LiquidGlassSurface
        colorScheme={theme.dark ? 'dark' : 'light'}
        fallbackStyle={{
          backgroundColor: theme.colors.surfaceVariant,
          borderColor: theme.colors.outlineVariant,
        }}
        isInteractive={false}
        style={styles.track}
        tintColor={theme.dark ? '#383838' : '#e4e4e4'}
      >
        {efforts.length ? (
          <View
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
              text: reasoningLabel(effort),
            }}
            onAccessibilityAction={event =>
              selectIndex(selectedIndex + (event.nativeEvent.actionName === 'increment' ? 1 : -1))
            }
            onLayout={event => setWidth(event.nativeEvent.layout.width)}
            onMoveShouldSetResponder={() => true}
            onResponderGrant={selectAt}
            onResponderMove={selectAt}
            onStartShouldSetResponder={() => true}
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
      </LiquidGlassSurface>
    </ModelControlSurface>
  )
}

const stylesConfig = {
  fillInset: 10,
  thumbSize: 52,
  trackInset: 34,
} as const

const styles = StyleSheet.create({
  dismissLayer: { position: 'absolute', inset: 0 },
  surface: {
    borderTopLeftRadius: 42,
    borderTopRightRadius: 42,
    overflow: 'hidden',
    paddingHorizontal: 18,
  },
  summary: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  label: { maxWidth: '80%', fontWeight: '400' },
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
    backgroundColor: '#43a5f5',
  },
  dots: {
    paddingHorizontal: 31,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dot: { width: 12, height: 12, borderRadius: 6, opacity: 0.72 },
  thumb: {
    position: 'absolute',
    top: 10,
    width: stylesConfig.thumbSize,
    height: stylesConfig.thumbSize,
    borderRadius: stylesConfig.thumbSize / 2,
    backgroundColor: '#f7f7f7',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 5,
  },
  pressed: { opacity: 0.55 },
})
