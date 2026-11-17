import Ionicons from '@expo/vector-icons/Ionicons'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AccessibilityInfo,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native'
import { Text, useTheme } from 'react-native-paper'

export interface Choice {
  id: string
  label: string
  detail?: string
  icon?: keyof typeof Ionicons.glyphMap
  separatorAfter?: boolean
  selected: boolean
  disabled?: boolean
  onPress: () => void
}

export function ChoiceSheet({
  choices,
  children,
  onDismiss,
  testIDPrefix,
  title,
  visible,
}: {
  choices: Choice[]
  children?: ReactNode
  onDismiss: () => void
  testIDPrefix: string
  title: string
  visible: boolean
}) {
  const theme = useTheme()
  const [presented, setPresented] = useState(visible)
  const [reduceMotion, setReduceMotion] = useState(false)
  const progress = useRef(new Animated.Value(visible ? 1 : 0)).current
  const closing = useRef(false)

  useEffect(() => {
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion)
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion)
    return () => subscription.remove()
  }, [])

  useEffect(() => {
    if (!visible) {
      setPresented(false)
      closing.current = false
      return
    }

    setPresented(true)
    progress.stopAnimation()
    progress.setValue(reduceMotion ? 1 : 0)
    if (reduceMotion) return

    Animated.timing(progress, {
      duration: 240,
      easing: Easing.out(Easing.cubic),
      toValue: 1,
      useNativeDriver: true,
    }).start()
  }, [progress, reduceMotion, visible])

  const dismiss = useCallback(() => {
    if (closing.current) return
    closing.current = true
    progress.stopAnimation()

    if (reduceMotion) {
      onDismiss()
      return
    }

    Animated.timing(progress, {
      duration: 180,
      easing: Easing.in(Easing.cubic),
      toValue: 0,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) onDismiss()
      else closing.current = false
    })
  }, [onDismiss, progress, reduceMotion])

  const backdropOpacity = progress
  const sheetTranslateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [52, 0],
  })

  return (
    <Modal
      animationType="none"
      navigationBarTranslucent
      onRequestClose={dismiss}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible={presented}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.sheetLayer}
      >
        <Animated.View
          pointerEvents="none"
          style={[
            styles.sheetBackdrop,
            {
              backgroundColor: theme.dark ? 'rgba(0,0,0,0.38)' : 'rgba(0,0,0,0.18)',
              opacity: backdropOpacity,
            },
          ]}
        />
        <Pressable
          accessibilityLabel={`关闭${title}选择`}
          accessibilityRole="button"
          onPress={dismiss}
          style={styles.sheetDismissLayer}
          testID={`${testIDPrefix}-dismiss`}
        />
        <Animated.View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            {
              backgroundColor: theme.colors.surface,
              transform: [{ translateY: reduceMotion ? 0 : sheetTranslateY }],
            },
          ]}
        >
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle} variant="titleLarge">
            {title}
          </Text>
          {children}
          <ScrollView
            contentContainerStyle={styles.sheetContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {choices.map(choice => (
              <View key={choice.id}>
                <Pressable
                  accessibilityRole="button"
                  disabled={choice.disabled}
                  accessibilityState={{ disabled: choice.disabled, selected: choice.selected }}
                  onPress={() => {
                    choice.onPress()
                    dismiss()
                  }}
                  style={({ pressed }) => [
                    styles.choice,
                    choice.disabled && { opacity: 0.45 },
                    choice.selected && { backgroundColor: theme.colors.surfaceVariant },
                    pressed && styles.pressed,
                  ]}
                  testID={`${testIDPrefix}-${choice.id}`}
                >
                  {choice.icon ? (
                    <Ionicons
                      color={theme.colors.onSurfaceVariant}
                      name={choice.icon}
                      size={23}
                      style={styles.choiceIcon}
                    />
                  ) : null}
                  <View style={styles.choiceText}>
                    <Text variant="bodyLarge">{choice.label}</Text>
                    {choice.detail ? (
                      <Text numberOfLines={1} style={styles.choiceDetail} variant="bodySmall">
                        {choice.detail}
                      </Text>
                    ) : null}
                  </View>
                  {choice.selected ? (
                    <Ionicons color={theme.colors.onSurface} name="checkmark" size={22} />
                  ) : null}
                </Pressable>
                {choice.separatorAfter ? (
                  <View
                    style={[
                      styles.choiceSeparator,
                      { backgroundColor: theme.colors.outlineVariant },
                    ]}
                  />
                ) : null}
              </View>
            ))}
          </ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.55 },
  sheetLayer: { flex: 1, justifyContent: 'flex-end' },
  sheetBackdrop: { position: 'absolute', inset: 0 },
  sheetDismissLayer: { position: 'absolute', inset: 0 },
  sheet: {
    maxHeight: '66%',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingBottom: Platform.OS === 'ios' ? 32 : 16,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 36,
    height: 5,
    borderRadius: 3,
    marginTop: 8,
    backgroundColor: '#858585',
  },
  sheetTitle: { paddingHorizontal: 22, paddingTop: 18, paddingBottom: 12 },
  sheetContent: { paddingHorizontal: 12, paddingBottom: 12 },
  choice: {
    minHeight: 60,
    borderRadius: 14,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
  },
  choiceText: { flex: 1, gap: 3 },
  choiceIcon: { marginRight: 14 },
  choiceDetail: { opacity: 0.48 },
  choiceSeparator: { height: StyleSheet.hairlineWidth, marginHorizontal: 14, marginVertical: 8 },
})
