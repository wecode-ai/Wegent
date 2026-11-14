import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react'
import {
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native'
import Animated, {
  Easing,
  cancelAnimation,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from 'react-native-paper'
import { conversationMenuFrame, type MenuAnchor } from '@/domain/conversationMenuGeometry'
import { LiquidGlassSurface } from './LiquidGlass'

export interface ConversationMenuSurfaceHandle {
  close: (afterClose?: () => void) => void
}

interface Props {
  anchor: MenuAnchor
  busy: boolean
  children: (interactive: boolean) => ReactNode
  onDismiss: () => void
  ref?: Ref<ConversationMenuSurfaceHandle>
}

export function ConversationMenuSurface({ anchor, busy, children, onDismiss, ref }: Props) {
  const theme = useTheme()
  const viewport = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const container = useRef<View>(null)
  const initialViewport = useRef({ width: viewport.width, height: viewport.height })
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null)
  const [contentHeight, setContentHeight] = useState(0)
  const [phase, setPhase] = useState<'opening' | 'open' | 'closing'>('opening')
  const closing = useRef(false)
  const afterClose = useRef<(() => void) | undefined>(undefined)
  const progress = useSharedValue(0)
  const target = conversationMenuFrame(anchor, viewport, insets, contentHeight)
  const finishClose = useCallback(() => {
    onDismiss()
    afterClose.current?.()
  }, [onDismiss])
  const close = useCallback(
    (action?: () => void) => {
      if (closing.current) return
      closing.current = true
      afterClose.current = action
      setPhase('closing')
      progress.value = withTiming(
        0,
        { duration: 180, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System },
        finished => {
          if (finished) runOnJS(finishClose)()
        }
      )
    },
    [finishClose, progress]
  )
  useImperativeHandle(ref, () => ({ close }), [close])
  useEffect(() => () => cancelAnimation(progress), [progress])
  useEffect(() => {
    if (!origin || contentHeight <= 0 || closing.current) return
    progress.value = withTiming(
      1,
      { duration: 240, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System },
      finished => {
        if (finished) runOnJS(setPhase)('open')
      }
    )
  }, [Boolean(origin), contentHeight > 0, progress])
  useEffect(() => {
    // A rotation invalidates the measured source frame. Restore the newly laid-out capsule.
    if (
      viewport.width !== initialViewport.current.width ||
      viewport.height !== initialViewport.current.height
    )
      onDismiss()
  }, [viewport.width, viewport.height, onDismiss])
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!busy) close()
      return true
    })
    return () => subscription.remove()
  }, [busy, close])
  const frameStyle = useAnimatedStyle(() => ({
    left: anchor.x + (target.x - anchor.x) * progress.value - (origin?.x ?? 0),
    top: anchor.y + (target.y - anchor.y) * progress.value - (origin?.y ?? 0),
    width: anchor.width + (target.width - anchor.width) * progress.value,
    height: anchor.height + (target.height - anchor.height) * progress.value,
    borderRadius: anchor.height / 2 + (34 - anchor.height / 2) * progress.value,
    opacity: origin ? 1 : 0,
  }))
  const contentStyle = useAnimatedStyle(() => ({
    opacity: Math.max(0, (progress.value - 0.3) / 0.7),
  }))
  const interactive = phase === 'open' && !busy
  return (
    <View
      ref={container}
      collapsable={false}
      style={StyleSheet.absoluteFill}
      accessibilityViewIsModal
      onLayout={() => container.current?.measureInWindow((x, y) => setOrigin({ x, y }))}
      testID="conversation-menu-overlay"
    >
      <Pressable
        accessibilityLabel="关闭会话菜单"
        accessibilityRole="button"
        disabled={busy || phase === 'closing'}
        onPress={() => close()}
        style={StyleSheet.absoluteFill}
        testID="conversation-menu-dismiss"
      />
      <Animated.View style={[styles.frame, frameStyle]} testID="conversation-menu-frame">
        <LiquidGlassSurface
          colorScheme={theme.dark ? 'dark' : 'light'}
          fallbackStyle={{
            backgroundColor: theme.colors.elevation.level3,
            borderColor: theme.colors.outlineVariant,
          }}
          isInteractive={false}
          style={styles.glass}
          testID="conversation-menu"
        >
          <View />
        </LiquidGlassSurface>
        <Animated.View
          pointerEvents={interactive ? 'auto' : 'none'}
          style={[styles.content, { width: target.width, height: target.height }, contentStyle]}
        >
          <ScrollView
            bounces={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.contentPadding}
            onContentSizeChange={(_width, height) => setContentHeight(height)}
            testID="conversation-menu-scroll"
          >
            {children(interactive)}
          </ScrollView>
        </Animated.View>
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  frame: { position: 'absolute', overflow: 'hidden' },
  glass: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, borderRadius: 34 },
  content: { position: 'absolute', top: 0, right: 0 },
  contentPadding: { paddingHorizontal: 24, paddingVertical: 12 },
})
