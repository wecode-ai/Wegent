import Ionicons from '@expo/vector-icons/Ionicons'
import { useEffect, useMemo, useRef, type ReactElement } from 'react'
import {
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native'
import { Text, useTheme } from 'react-native-paper'

interface Props {
  open: boolean
  disabled: boolean
  selected?: boolean
  onOpen: () => void
  onClose: () => void
  onSwipeStart: () => void
  onPress: () => void
  onArchive: () => void
  testID: string
  children: (onPress: () => void) => ReactElement
}

export function SwipeArchiveRow(props: Props) {
  const theme = useTheme()
  const { fontScale } = useWindowDimensions()
  const width = Math.ceil(88 * Math.max(1, fontScale))
  const offset = useRef(new Animated.Value(0)).current
  const start = useRef(0)
  useEffect(() => {
    const animation = Animated.spring(offset, {
      toValue: props.open && !props.disabled ? -width : 0,
      useNativeDriver: true,
      overshootClamping: true,
      speed: 24,
      bounciness: 0,
    })
    animation.start()
    return () => animation.stop()
  }, [offset, props.open, props.disabled, width])
  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) =>
          !props.disabled &&
          Math.abs(gesture.dx) > 12 &&
          Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5 &&
          (props.open || gesture.dx < 0),
        onPanResponderGrant: () => {
          offset.stopAnimation()
          start.current = props.open ? -width : 0
          props.onSwipeStart()
        },
        onPanResponderMove: (_, gesture) => {
          offset.setValue(Math.min(0, Math.max(-width, start.current + gesture.dx)))
        },
        onPanResponderRelease: (_, gesture) => {
          const position = Math.min(0, Math.max(-width, start.current + gesture.dx))
          const reveal = gesture.vx < -0.5 || (gesture.vx <= 0.5 && position < -width * 0.4)
          // Always settle, including when the controlled open value has not changed.
          Animated.spring(offset, {
            toValue: reveal ? -width : 0,
            useNativeDriver: true,
            overshootClamping: true,
          }).start()
          if (reveal) props.onOpen()
          else props.onClose()
        },
        onPanResponderTerminate: () => {
          Animated.spring(offset, { toValue: 0, useNativeDriver: true }).start()
          props.onClose()
        },
        onPanResponderTerminationRequest: () => true,
      }),
    [offset, props.disabled, props.open, props.onOpen, props.onClose, props.onSwipeStart, width]
  )
  return (
    <View style={styles.row} testID={props.testID} {...responder.panHandlers}>
      <View
        style={[styles.actions, { width }]}
        accessibilityElementsHidden={!props.open}
        importantForAccessibility={props.open ? 'auto' : 'no-hide-descendants'}
        pointerEvents={props.open ? 'auto' : 'none'}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="归档"
          disabled={props.disabled || !props.open}
          accessibilityState={{ disabled: props.disabled || !props.open }}
          onPress={() => {
            if (!props.disabled && props.open) {
              props.onClose()
              props.onArchive()
            }
          }}
          style={[styles.archive, { backgroundColor: theme.colors.error }]}
          testID={`${props.testID}-archive`}
        >
          <Ionicons name="archive-outline" size={20} color={theme.colors.onError} />
          <Text variant="labelLarge" style={{ color: theme.colors.onError }}>
            归档
          </Text>
        </Pressable>
      </View>
      <Animated.View
        style={{
          transform: [{ translateX: offset }],
          backgroundColor: props.selected ? theme.colors.surfaceVariant : theme.colors.background,
        }}
      >
        {props.children(() => {
          if (props.open) props.onClose()
          else props.onPress()
        })}
      </Animated.View>
    </View>
  )
}
const styles = StyleSheet.create({
  row: { width: '100%', minHeight: 48, overflow: 'hidden', borderRadius: 12 },
  actions: { position: 'absolute', top: 2, right: 0, bottom: 2, justifyContent: 'center' },
  archive: {
    minHeight: 44,
    borderRadius: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 12,
  },
})
