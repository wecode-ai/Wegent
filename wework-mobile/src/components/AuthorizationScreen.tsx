import type { GlassColorScheme } from 'expo-glass-effect'
import { useEffect, useRef } from 'react'
import { StyleSheet, View } from 'react-native'
import { ActivityIndicator, Text, useTheme } from 'react-native-paper'

import type { AuthStatus } from '@/auth/useWegentAuth'
import { LiquidGlassButton, liquidGlassAccentBorder, liquidGlassAccentTint } from './LiquidGlass'

interface AuthorizationScreenProps {
  status: AuthStatus
  backendUrl: string
  error: string | null
  onAuthorize: () => Promise<void>
}

export function AuthorizationScreen(props: AuthorizationScreenProps) {
  const theme = useTheme()
  const glassColorScheme: GlassColorScheme = theme.dark ? 'dark' : 'light'
  const started = useRef(false)
  useEffect(() => {
    if (started.current || props.status !== 'unauthenticated') return
    started.current = true
    void props.onAuthorize().catch(() => undefined)
  }, [props])

  const working = props.status === 'initializing' || props.status === 'authorizing'
  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={styles.brand}>
        <Text variant="displaySmall">Wegent</Text>
        <Text style={styles.description} variant="bodyLarge">
          使用与 Wework 相同的 Wegent Web 页面完成授权登录
        </Text>
      </View>
      {working ? <ActivityIndicator size="large" /> : null}
      <Text selectable style={styles.backend} variant="bodySmall">
        {props.backendUrl}
      </Text>
      {props.error ? (
        <Text style={[styles.error, { color: theme.colors.error }]} variant="bodyMedium">
          {props.error}
        </Text>
      ) : null}
      {!working ? (
        <LiquidGlassButton
          colorScheme={glassColorScheme}
          contentStyle={styles.buttonContent}
          fallbackStyle={{
            backgroundColor: liquidGlassAccentTint,
            borderColor: liquidGlassAccentBorder,
          }}
          glassEffectStyle="regular"
          onPress={() => void props.onAuthorize().catch(() => undefined)}
          style={styles.buttonGlass}
          testID="authorize-login"
          tintColor={liquidGlassAccentTint}
        >
          <Text style={styles.buttonLabel} variant="labelLarge">
            打开 Wegent 登录
          </Text>
        </LiquidGlassButton>
      ) : (
        <Text style={styles.hint} variant="bodyMedium">
          请在打开的页面中登录并批准授权
        </Text>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
    gap: 20,
  },
  brand: { alignItems: 'center', gap: 10, marginBottom: 16 },
  description: { textAlign: 'center', opacity: 0.6 },
  backend: { opacity: 0.5 },
  error: { textAlign: 'center' },
  hint: { opacity: 0.6, textAlign: 'center' },
  buttonGlass: {
    width: 176,
    height: 44,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
  },
  buttonContent: {
    width: '100%',
    height: '100%',
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  buttonLabel: { color: '#ffffff', fontWeight: '600' },
})
