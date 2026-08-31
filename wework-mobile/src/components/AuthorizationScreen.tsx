import type { GlassColorScheme } from 'expo-glass-effect'
import { StyleSheet, View } from 'react-native'
import { ActivityIndicator, Text, useTheme } from 'react-native-paper'

import type { AuthStatus } from '@/auth/useWegentAuth'
import { KeyboardSafePaperTextInput, KeyboardSafeView } from './KeyboardSafeInput'
import { LiquidGlassButton, liquidGlassAccentBorder, liquidGlassAccentTint } from './LiquidGlass'

interface AuthorizationScreenProps {
  status: AuthStatus
  backendUrl: string
  error: string | null
  onBackendUrlChange: (value: string) => void
  onAuthorize: () => Promise<void>
}

export function AuthorizationScreen(props: AuthorizationScreenProps) {
  const theme = useTheme()
  const glassColorScheme: GlassColorScheme = theme.dark ? 'dark' : 'light'
  const working = props.status === 'initializing' || props.status === 'authorizing'
  return (
    <KeyboardSafeView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={styles.brand}>
        <Text variant="displaySmall">Wegent</Text>
        <Text style={styles.description} variant="bodyLarge">
          使用与 Wework 相同的 Wegent Web 页面完成授权登录
        </Text>
      </View>
      {working ? <ActivityIndicator size="large" /> : null}
      <KeyboardSafePaperTextInput
        autoCapitalize="none"
        autoCorrect={false}
        disabled={working}
        keyboardType="url"
        label="Backend 地址"
        mode="outlined"
        onChangeText={props.onBackendUrlChange}
        onSubmitEditing={() => void props.onAuthorize().catch(() => undefined)}
        placeholder="https://example.com"
        returnKeyType="go"
        style={styles.backendInput}
        testID="backend-address"
        value={props.backendUrl}
      />
      {props.error ? (
        <Text style={[styles.error, { color: theme.colors.error }]} variant="bodyMedium">
          {props.error}
        </Text>
      ) : null}
      {!working ? (
        <LiquidGlassButton
          colorScheme={glassColorScheme}
          contentStyle={styles.buttonContent}
          disabled={working || !props.backendUrl.trim()}
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
    </KeyboardSafeView>
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
  backendInput: { width: '100%', maxWidth: 420 },
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
