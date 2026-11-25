import Ionicons from '@expo/vector-icons/Ionicons'
import { useEffect, useRef } from 'react'
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native'
import { Text, useTheme } from 'react-native-paper'

import type { ComposerVoiceState } from '@/hooks/useComposerVoiceInput'

const voiceBlue = '#0a84ff'
const voiceRed = '#ff3b30'

interface VoiceInputBarProps {
  errorMessage: string
  levels: number[]
  onCancel: () => void
  onRetry: () => void
  onSend: () => void
  onStop: () => void
  state: Exclude<ComposerVoiceState, 'idle'>
}

export function VoiceGlyph({ color = '#ffffff' }: { color?: string }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.glyph}
    >
      <View style={[styles.glyphBar, { backgroundColor: color, height: 5 }]} />
      <View style={[styles.glyphBar, { backgroundColor: color, height: 11 }]} />
      <View style={[styles.glyphBar, { backgroundColor: color, height: 7 }]} />
    </View>
  )
}

export function VoiceInputBar({
  errorMessage,
  levels,
  onCancel,
  onRetry,
  onSend,
  onStop,
  state,
}: VoiceInputBarProps) {
  const theme = useTheme()
  const muted = theme.dark ? '#8e8e93' : '#c7c7cc'
  const surfaceMuted = theme.dark ? '#2c2c2e' : '#f2f2f7'
  const strong = theme.colors.onSurface

  if (state === 'error') {
    return (
      <View style={styles.bar} testID="composer-voice-bar">
        <Pressable
          accessibilityLabel="取消语音输入"
          accessibilityRole="button"
          onPress={onCancel}
          style={({ pressed }) => [
            styles.circleButton,
            { backgroundColor: theme.dark ? '#3a1f20' : '#fdecec' },
            pressed && styles.pressed,
          ]}
          testID="composer-voice-cancel"
        >
          <Ionicons color={voiceRed} name="close" size={19} />
        </Pressable>
        <View style={styles.errorSpacer} />
        <View pointerEvents="none" style={styles.errorLabelContainer}>
          <Text
            accessibilityHint={errorMessage}
            accessibilityLabel={`转文字出错。${errorMessage}`}
            numberOfLines={1}
            style={styles.errorText}
            testID="composer-voice-error"
          >
            转文字出错
          </Text>
        </View>
        <Ionicons color={muted} name="mic-outline" size={21} />
        <Pressable
          accessibilityLabel="重新转写"
          accessibilityRole="button"
          onPress={onRetry}
          style={({ pressed }) => [
            styles.sendButton,
            { backgroundColor: voiceBlue },
            pressed && styles.pressed,
          ]}
          testID="composer-voice-retry"
        >
          <Ionicons color="#ffffff" name="refresh" size={20} />
        </Pressable>
      </View>
    )
  }

  return (
    <View style={styles.bar} testID="composer-voice-bar">
      <Pressable
        accessibilityLabel="取消语音输入"
        accessibilityRole="button"
        onPress={onCancel}
        style={({ pressed }) => [
          styles.circleButton,
          { backgroundColor: surfaceMuted },
          pressed && styles.pressed,
        ]}
        testID="composer-voice-cancel"
      >
        <Ionicons color={strong} name="close" size={18} />
      </Pressable>
      <VoiceWaveform levels={levels} />
      {state === 'recording' ? (
        <Pressable
          accessibilityLabel="停止录音"
          accessibilityRole="button"
          onPress={onStop}
          style={({ pressed }) => [
            styles.stopButton,
            { backgroundColor: surfaceMuted },
            pressed && styles.pressed,
          ]}
          testID="composer-voice-stop"
        >
          <View style={[styles.stopGlyph, { backgroundColor: strong }]} />
        </Pressable>
      ) : (
        <View
          style={[styles.stopButton, { backgroundColor: surfaceMuted }]}
          testID="composer-voice-spinner"
        >
          <TranscribingSpinner color={muted} edgeColor={strong} />
        </View>
      )}
      <Pressable
        accessibilityLabel="发送语音消息"
        accessibilityRole="button"
        accessibilityState={{ disabled: state === 'starting' }}
        disabled={state === 'starting'}
        onPress={onSend}
        style={({ pressed }) => [
          styles.sendButton,
          { backgroundColor: voiceBlue },
          state === 'starting' && styles.stopping,
          pressed && styles.pressed,
        ]}
        testID="composer-voice-send"
      >
        <Ionicons color="#ffffff" name="arrow-up" size={20} />
      </Pressable>
    </View>
  )
}

function VoiceWaveform({ levels }: { levels: number[] }) {
  const bars = levels.slice(-36)
  return (
    <View accessibilityElementsHidden style={styles.waveform} testID="composer-voice-waveform">
      {bars.map((level, index) => {
        const height = 2 + Math.round(level * 18)
        return (
          <View
            key={index}
            style={[
              styles.waveformBar,
              {
                height,
                opacity: 0.45 + level * 0.55,
              },
            ]}
          />
        )
      })}
    </View>
  )
}

function TranscribingSpinner({ color, edgeColor }: { color: string; edgeColor: string }) {
  const rotation = useRef(new Animated.Value(0)).current
  useEffect(() => {
    const animation = Animated.loop(
      Animated.timing(rotation, {
        duration: 900,
        easing: Easing.linear,
        toValue: 1,
        useNativeDriver: true,
      })
    )
    animation.start()
    return () => animation.stop()
  }, [rotation])
  return (
    <Animated.View
      style={[
        styles.spinner,
        {
          borderColor: color,
          borderTopColor: edgeColor,
          transform: [
            {
              rotate: rotation.interpolate({
                inputRange: [0, 1],
                outputRange: ['0deg', '360deg'],
              }),
            },
          ],
        },
      ]}
    />
  )
}

const styles = StyleSheet.create({
  bar: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 9,
  },
  circleButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopGlyph: { width: 10, height: 10, borderRadius: 1.5 },
  sendButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorSpacer: { flex: 1 },
  errorLabelContainer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorText: {
    color: voiceRed,
    fontSize: 17,
    fontWeight: '500',
    textAlign: 'center',
  },
  waveform: {
    flex: 1,
    height: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    overflow: 'hidden',
  },
  waveformBar: {
    width: 2,
    borderRadius: 1,
    backgroundColor: '#8e8e93',
  },
  spinner: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
  },
  glyph: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2.5,
  },
  glyphBar: { width: 2.5, borderRadius: 1.25 },
  pressed: { opacity: 0.7 },
  stopping: { opacity: 0.45 },
})
