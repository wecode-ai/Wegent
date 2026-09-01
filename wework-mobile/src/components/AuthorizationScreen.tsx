import Ionicons from '@expo/vector-icons/Ionicons'
import type { GlassColorScheme } from 'expo-glass-effect'
import { LinearGradient } from 'expo-linear-gradient'
import { useEffect, useState } from 'react'
import { Image, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native'
import { ActivityIndicator, Text, useTheme } from 'react-native-paper'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import type { AuthStatus } from '@/auth/useWegentAuth'
import { KeyboardSafePaperTextInput, KeyboardSafeView } from './KeyboardSafeInput'
import { LiquidGlassButton, LiquidGlassSurface } from './LiquidGlass'

interface AuthorizationScreenProps {
  status: AuthStatus
  backendUrl: string
  error: string | null
  onBackendUrlChange: (value: string) => void
  onAuthorize: () => Promise<void>
}

const capabilityItems = [
  { icon: 'cloud-outline' as const, label: '云设备' },
  { icon: 'sync-outline' as const, label: '会话同步' },
  { icon: 'shield-checkmark-outline' as const, label: '安全授权' },
]

export function AuthorizationScreen(props: AuthorizationScreenProps) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const { height } = useWindowDimensions()
  const glassColorScheme: GlassColorScheme = theme.dark ? 'dark' : 'light'
  const working = props.status === 'initializing' || props.status === 'authorizing'
  const authorizing = props.status === 'authorizing'
  const configured = Boolean(props.backendUrl.trim())
  const [configurationVisible, setConfigurationVisible] = useState(!configured)
  const [configurationTouched, setConfigurationTouched] = useState(false)

  useEffect(() => {
    if (!configurationTouched && configured) setConfigurationVisible(false)
  }, [configurationTouched, configured])

  const openConfiguration = () => {
    setConfigurationTouched(true)
    setConfigurationVisible(true)
  }

  const handleAuthorize = () => {
    if (!configured) {
      openConfiguration()
      return
    }
    void props.onAuthorize().catch(() => undefined)
  }

  const primaryTint = theme.dark ? 'rgba(248, 248, 248, 0.88)' : 'rgba(20, 20, 20, 0.9)'
  const primaryLabelColor = theme.dark ? '#111111' : '#ffffff'
  const cardFallback = {
    backgroundColor: theme.dark ? 'rgba(28, 28, 28, 0.94)' : 'rgba(255, 255, 255, 0.88)',
    borderColor: theme.colors.outlineVariant,
  }

  return (
    <KeyboardSafeView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <LinearGradient
        colors={
          theme.dark
            ? ['rgba(255,255,255,0.08)', 'rgba(0,0,0,0)', 'rgba(0,0,0,0)']
            : ['rgba(228,232,238,0.78)', 'rgba(255,255,255,0)', 'rgba(255,255,255,0)']
        }
        locations={[0, 0.46, 1]}
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
      />
      <View
        pointerEvents="none"
        style={[
          styles.ambientOrb,
          styles.ambientOrbLeading,
          { backgroundColor: theme.dark ? '#243044' : '#d7e2ef' },
        ]}
      />
      <View
        pointerEvents="none"
        style={[
          styles.ambientOrb,
          styles.ambientOrbTrailing,
          { backgroundColor: theme.dark ? '#292929' : '#ece7df' },
        ]}
      />

      <ScrollView
        bounces={false}
        contentContainerStyle={[
          styles.content,
          {
            minHeight: height,
            paddingTop: insets.top + 56,
            paddingBottom: insets.bottom + 24,
          },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.hero}>
          <Image
            accessibilityLabel="Wework"
            resizeMode="contain"
            source={require('../../assets/wework-logo-transparent.png')}
            style={styles.brandLogo}
            testID="authorization-brand-logo"
          />

          <Text style={styles.eyebrow} variant="labelLarge">
            WEGENT MOBILE
          </Text>
          <Text style={styles.title} variant="displaySmall">
            连接 Wework 云设备
          </Text>
          <Text
            style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}
            variant="bodyLarge"
          >
            在手机上查看、继续和控制你的云端任务。
          </Text>

          <View style={styles.capabilities}>
            {capabilityItems.map(item => (
              <View key={item.label} style={styles.capabilityItem}>
                <Ionicons color={theme.colors.onSurfaceVariant} name={item.icon} size={17} />
                <Text style={{ color: theme.colors.onSurfaceVariant }} variant="labelMedium">
                  {item.label}
                </Text>
              </View>
            ))}
          </View>
        </View>

        <LiquidGlassSurface
          colorScheme={glassColorScheme}
          fallbackStyle={cardFallback}
          glassEffectStyle="regular"
          isInteractive={false}
          style={styles.connectionCard}
          testID="authorization-card"
        >
          <View style={styles.cardContent}>
            <View style={styles.cardHeader}>
              <View style={styles.cardHeaderCopy}>
                <Text style={styles.cardTitle} variant="titleMedium">
                  {authorizing ? '等待授权' : '登录并连接'}
                </Text>
                <Text style={{ color: theme.colors.onSurfaceVariant }} variant="bodyMedium">
                  {authorizing ? '请在打开的 Wework 页面中完成授权' : '同步云设备、模型和会话'}
                </Text>
              </View>
              <View style={[styles.lockBadge, { backgroundColor: theme.colors.surfaceVariant }]}>
                {working ? (
                  <ActivityIndicator color={theme.colors.onSurface} size={18} />
                ) : (
                  <Ionicons color={theme.colors.onSurface} name="lock-closed" size={17} />
                )}
              </View>
            </View>

            {configured && !configurationVisible ? (
              <Pressable
                accessibilityLabel="更改 Wegent 服务地址"
                accessibilityRole="button"
                disabled={working}
                onPress={openConfiguration}
                style={({ pressed }) => [
                  styles.serverRow,
                  { borderColor: theme.colors.outlineVariant },
                  pressed && styles.pressed,
                ]}
                testID="authorization-server-change"
              >
                <Ionicons color={theme.colors.onSurfaceVariant} name="server-outline" size={19} />
                <View style={styles.serverCopy}>
                  <Text numberOfLines={1} variant="labelLarge">
                    {displayHost(props.backendUrl)}
                  </Text>
                  <Text style={{ color: theme.colors.onSurfaceVariant }} variant="bodySmall">
                    Wegent 服务
                  </Text>
                </View>
                <Text style={{ color: theme.colors.onSurfaceVariant }} variant="labelMedium">
                  更改
                </Text>
              </Pressable>
            ) : (
              <View style={styles.configuration}>
                <KeyboardSafePaperTextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  disabled={working}
                  keyboardType="url"
                  label="Wegent 服务地址"
                  mode="outlined"
                  onChangeText={props.onBackendUrlChange}
                  onSubmitEditing={handleAuthorize}
                  outlineColor={theme.colors.outlineVariant}
                  placeholder="https://wegent.example.com"
                  returnKeyType="go"
                  style={styles.backendInput}
                  testID="backend-address"
                  value={props.backendUrl}
                />
                <Text style={{ color: theme.colors.onSurfaceVariant }} variant="bodySmall">
                  可填写 Backend 根地址或 /api 地址
                </Text>
              </View>
            )}

            {props.error ? (
              <View
                style={[
                  styles.errorBox,
                  {
                    backgroundColor: theme.dark ? 'rgba(255,69,58,0.14)' : 'rgba(215,45,38,0.08)',
                  },
                ]}
                testID="authorization-error"
              >
                <Ionicons color={theme.colors.error} name="alert-circle-outline" size={18} />
                <Text
                  style={[styles.errorText, { color: theme.colors.error }]}
                  variant="bodyMedium"
                >
                  {props.error}
                </Text>
              </View>
            ) : null}

            <LiquidGlassButton
              accessibilityLabel={authorizing ? '等待 Wework 授权' : '登录并连接'}
              colorScheme={glassColorScheme}
              contentStyle={styles.primaryButtonContent}
              disabled={working}
              fallbackStyle={{
                backgroundColor: theme.dark ? '#f5f5f5' : '#181818',
                borderColor: theme.dark ? '#ffffff' : '#181818',
              }}
              glassEffectStyle="regular"
              onPress={handleAuthorize}
              style={styles.primaryButton}
              testID="authorize-login"
              tintColor={primaryTint}
            >
              {working ? (
                <ActivityIndicator color={primaryLabelColor} size={18} />
              ) : (
                <Ionicons color={primaryLabelColor} name="arrow-forward" size={20} />
              )}
              <Text
                style={[styles.primaryButtonLabel, { color: primaryLabelColor }]}
                variant="labelLarge"
              >
                {authorizing ? '等待 Wework 授权' : configured ? '登录并连接' : '继续'}
              </Text>
            </LiquidGlassButton>

            <View style={styles.securityNote}>
              <Ionicons color={theme.colors.onSurfaceVariant} name="shield-checkmark" size={14} />
              <Text style={{ color: theme.colors.onSurfaceVariant }} variant="bodySmall">
                使用 Wegent Web 安全授权，不在手机保存密码
              </Text>
            </View>
          </View>
        </LiquidGlassSurface>
      </ScrollView>
    </KeyboardSafeView>
  )
}

function displayHost(value: string): string {
  const normalized = value.trim()
  if (!normalized) return ''
  try {
    return new URL(normalized.includes('://') ? normalized : `https://${normalized}`).host
  } catch {
    return normalized
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, overflow: 'hidden' },
  content: {
    flexGrow: 1,
    justifyContent: 'space-between',
    gap: 48,
    paddingHorizontal: 22,
  },
  ambientOrb: {
    position: 'absolute',
    width: 260,
    height: 260,
    borderRadius: 130,
    opacity: 0.42,
  },
  ambientOrbLeading: { top: -104, left: -116 },
  ambientOrbTrailing: { top: 128, right: -184 },
  hero: { alignItems: 'center', paddingHorizontal: 8 },
  brandLogo: {
    width: 124,
    height: 124,
    marginBottom: 28,
  },
  eyebrow: { letterSpacing: 1.7, opacity: 0.5, marginBottom: 10 },
  title: { textAlign: 'center', fontWeight: '600', letterSpacing: -0.8 },
  subtitle: {
    maxWidth: 360,
    textAlign: 'center',
    lineHeight: 26,
    marginTop: 12,
  },
  capabilities: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: 18,
    marginTop: 28,
  },
  capabilityItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  connectionCard: {
    width: '100%',
    maxWidth: 440,
    alignSelf: 'center',
    borderRadius: 30,
    overflow: 'hidden',
  },
  cardContent: { padding: 20, gap: 16 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  cardHeaderCopy: { flex: 1, gap: 3 },
  cardTitle: { fontWeight: '600' },
  lockBadge: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  serverRow: {
    minHeight: 62,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 18,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  serverCopy: { flex: 1, gap: 1 },
  configuration: { gap: 7 },
  backendInput: { width: '100%', backgroundColor: 'transparent' },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  errorText: { flex: 1 },
  primaryButton: { width: '100%', height: 52, borderRadius: 26 },
  primaryButtonContent: {
    width: '100%',
    height: '100%',
    borderRadius: 26,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    paddingHorizontal: 18,
  },
  primaryButtonLabel: { fontWeight: '700' },
  securityNote: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  pressed: { opacity: 0.7 },
})
