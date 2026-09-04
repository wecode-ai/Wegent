import { LinearGradient } from 'expo-linear-gradient'
import { StyleSheet } from 'react-native'
import { useTheme } from 'react-native-paper'

interface ConversationEdgeMaskProps {
  edge: 'top' | 'bottom'
  height: number
}

export function ConversationEdgeMask({ edge, height }: ConversationEdgeMaskProps) {
  const theme = useTheme()
  const topColors = theme.dark
    ? (['rgba(0,0,0,0.98)', 'rgba(0,0,0,0.9)', 'rgba(0,0,0,0.64)', 'rgba(0,0,0,0)'] as const)
    : ([
        'rgba(255,255,255,0.98)',
        'rgba(255,255,255,0.92)',
        'rgba(255,255,255,0.68)',
        'rgba(255,255,255,0)',
      ] as const)
  const colors = edge === 'top' ? topColors : reverseColors(topColors)
  const locations = edge === 'top' ? ([0, 0.58, 0.8, 1] as const) : ([0, 0.2, 0.42, 1] as const)

  return (
    <LinearGradient
      colors={colors}
      locations={locations}
      pointerEvents="none"
      style={[styles.mask, edge === 'top' ? styles.top : styles.bottom, { height }]}
      testID={`conversation-${edge}-mask`}
    />
  )
}

function reverseColors(
  colors: readonly [string, string, string, string]
): [string, string, string, string] {
  return [colors[3], colors[2], colors[1], colors[0]]
}

const styles = StyleSheet.create({
  mask: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  top: { top: 0 },
  bottom: { bottom: 0 },
})
