import { useEffect } from 'react'
import { StyleSheet, View } from 'react-native'
import { useTheme } from 'react-native-paper'
import Animated, {
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated'
import Svg, { Circle } from 'react-native-svg'

const AnimatedCircle = Animated.createAnimatedComponent(Circle)
const strokeWidth = 2.5
const startAngle = 120
const springConfig = { damping: 18, stiffness: 220, mass: 0.7 }

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

export function ModelDialIcon({ progress, size = 28 }: { progress: number; size?: number }) {
  const theme = useTheme()
  const value = useSharedValue(clamp(progress))
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const leverWidth = Math.max(2.5, size * 0.1)
  const knobSize = size * 0.26

  useEffect(() => {
    value.value = withSpring(clamp(progress), springConfig)
  }, [progress, value])

  const arcProps = useAnimatedProps(() => {
    const normalized = Math.max(0, Math.min(1, value.value))
    return {
      strokeDashoffset: circumference * (1 - (0.12 + normalized * 0.38)),
    }
  })
  const leverStyle = useAnimatedStyle(() => {
    const normalized = Math.max(0, Math.min(1, value.value))
    return {
      transform: [{ rotate: `${-90 + normalized * 135}deg` }],
    }
  })

  const trackColor = theme.dark ? '#8e8e93' : '#c7c7cc'
  const knobColor = theme.dark ? '#f2f2f7' : '#1c1c1e'

  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          fill="none"
          r={radius}
          stroke={trackColor}
          strokeWidth={strokeWidth}
        />
        <AnimatedCircle
          animatedProps={arcProps}
          cx={size / 2}
          cy={size / 2}
          fill="none"
          origin={`${size / 2}, ${size / 2}`}
          r={radius}
          rotation={startAngle}
          stroke="#0a84ff"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeLinecap="round"
          strokeWidth={strokeWidth}
        />
      </Svg>
      <Animated.View
        pointerEvents="none"
        style={[styles.lever, { width: size, height: size }, leverStyle]}
      >
        <View
          style={[
            styles.leverLine,
            {
              backgroundColor: knobColor,
              height: size * 0.26,
              left: (size - leverWidth) / 2,
              top: size * 0.18,
              width: leverWidth,
            },
          ]}
        />
        <View
          style={[
            styles.leverKnob,
            {
              backgroundColor: theme.colors.surface,
              borderColor: knobColor,
              borderWidth: Math.max(2, size * 0.08),
              height: knobSize,
              left: (size - knobSize) / 2,
              top: (size - knobSize) / 2,
              width: knobSize,
            },
          ]}
        />
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  lever: { position: 'absolute', left: 0, top: 0 },
  leverLine: { position: 'absolute', borderRadius: 2 },
  leverKnob: { position: 'absolute', borderRadius: 999 },
})
