import Ionicons from '@expo/vector-icons/Ionicons'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { Text, useTheme } from 'react-native-paper'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { WegentAuthState } from '@/auth/useWegentAuth'
import type { LocalRuntime, LocalRuntimeProfile, LocalRuntimeStatus } from '@/services/localRuntime'
import { confirmNativeAction, showErrorAlert } from '@/services/errorAlerts'
import { phoneLocalModels, type PhoneLocalModel } from '@/services/phoneLocalModels'
import { usePhoneModelProviders } from '@/hooks/usePhoneModelProviders'
import { AuthorizationScreen } from './AuthorizationScreen'
import { LocalRuntimeSettings } from './LocalRuntimeSettings'
import { ErrorNotice } from './errors/ErrorNotice'
import { DiagnosticsSettings } from './DiagnosticsSettings'
import { TelemetryPrivacySettings } from './TelemetryPrivacySettings'

export function SettingsPage({
  title,
  onBack,
  children,
  close = false,
  keyboard = false,
}: {
  title: string
  onBack: () => void
  children: ReactNode
  close?: boolean
  keyboard?: boolean
}) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const Container = keyboard ? KeyboardAwareScrollView : ScrollView
  return (
    <View style={[styles.screen, { backgroundColor: theme.colors.background }]}>
      <Container
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 },
        ]}
        testID={keyboard ? 'settings-form-scroll' : 'settings-page-scroll'}
      >
        <View style={[styles.header, close && styles.closeHeader]}>
          {!close && (
            <SettingsIcon
              name="chevron-back"
              label="返回"
              onPress={onBack}
              testID="settings-back"
            />
          )}
          {!close && (
            <Text variant="titleMedium" style={styles.title}>
              {title}
            </Text>
          )}
          {close ? (
            <SettingsIcon
              name="close"
              label="关闭设置"
              onPress={onBack}
              testID="close-settings"
              filled
            />
          ) : (
            <View style={styles.icon} />
          )}
        </View>
        {children}
      </Container>
    </View>
  )
}

function SettingsIcon({
  name,
  label,
  onPress,
  testID,
  filled = false,
}: {
  name: React.ComponentProps<typeof Ionicons>['name']
  label: string
  onPress: () => void
  testID: string
  filled?: boolean
}) {
  const theme = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      onPress={onPress}
      style={[styles.icon, filled && { backgroundColor: theme.colors.surfaceVariant }]}
    >
      <Ionicons name={name} size={filled ? 27 : 24} color={theme.colors.onSurface} />
    </Pressable>
  )
}

export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  const theme = useTheme()
  return (
    <View style={styles.section}>
      <Text
        variant="titleSmall"
        style={[styles.sectionTitle, { color: theme.colors.onSurfaceVariant }]}
      >
        {title}
      </Text>
      <View style={[styles.group, { backgroundColor: theme.colors.surfaceVariant }]}>
        {children}
      </View>
    </View>
  )
}

export function SettingsRow({
  label,
  detail,
  icon,
  onPress,
  testID,
  separator = false,
  disabled = false,
}: {
  label: string
  detail?: string
  icon: React.ComponentProps<typeof Ionicons>['name']
  onPress: () => void
  testID: string
  separator?: boolean
  disabled?: boolean
}) {
  const theme = useTheme()
  return (
    <View>
      {separator && (
        <View style={[styles.separator, { backgroundColor: theme.colors.outlineVariant }]} />
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        testID={testID}
        style={[styles.row, disabled && { opacity: 0.45 }]}
      >
        <Ionicons name={icon} size={23} color={theme.colors.onSurface} />
        <Text variant="bodyLarge" style={styles.rowLabel}>
          {label}
        </Text>
        {detail && (
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            {detail}
          </Text>
        )}
        <Ionicons name="chevron-forward" size={17} color={theme.colors.onSurfaceVariant} />
      </Pressable>
    </View>
  )
}

export function SettingsAction({
  children,
  onPress,
  testID,
  disabled = false,
  secondary = false,
}: {
  children: ReactNode
  onPress: () => void
  testID: string
  disabled?: boolean
  secondary?: boolean
}) {
  const theme = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.action,
        {
          opacity: disabled ? 0.45 : 1,
          backgroundColor: secondary ? theme.colors.surfaceVariant : theme.colors.onSurface,
        },
      ]}
    >
      <Text
        variant="labelLarge"
        style={{ color: secondary ? theme.colors.onSurface : theme.colors.surface }}
      >
        {children}
      </Text>
    </Pressable>
  )
}

export function usePhoneModels() {
  const [models, setModels] = useState<PhoneLocalModel[]>([])
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    let active = true
    const refresh = () => {
      void phoneLocalModels.list().then(
        value => {
          if (active) {
            setModels(value)
            setError(null)
          }
        },
        cause => {
          if (active) setError(cause)
        }
      )
    }
    refresh()
    const unsubscribe = phoneLocalModels.subscribe(refresh)
    return () => {
      active = false
      unsubscribe()
    }
  }, [])
  return { models, error }
}

export function SettingsScreen({
  auth,
  status,
  localError,
  onClose,
  onModels,
  onExecution,
  onBackend,
  onPrivacy,
}: {
  auth: WegentAuthState
  status: LocalRuntimeStatus
  localError: unknown
  onClose: () => void
  onModels: () => void
  onExecution: () => void
  onBackend: () => void
  onPrivacy: () => void
}) {
  const theme = useTheme()
  const { models, error } = usePhoneModels()
  const providers = usePhoneModelProviders()
  const modelCount =
    models.length +
    (providers.snapshot?.providers.reduce((total, provider) => total + provider.models.length, 0) ??
      0)
  return (
    <SettingsPage title="设置" onBack={onClose} close>
      <View style={styles.profile}>
        <Ionicons
          accessible
          accessibilityLabel="个人头像"
          name="person-circle"
          size={72}
          color={theme.colors.onSurfaceVariant}
        />
        {auth.user?.full_name && <Text variant="bodyMedium">{auth.user.full_name}</Text>}
      </View>
      <View style={[styles.intro, { backgroundColor: theme.colors.surfaceVariant }]}>
        <View style={styles.introCopy}>
          <Text variant="titleMedium">使用你的模型</Text>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            登录 OpenAI 或添加模型服务
          </Text>
        </View>
        <SettingsAction onPress={onModels} testID="settings-configure-models">
          配置
        </SettingsAction>
      </View>
      <SettingsGroup title="模型与执行">
        <SettingsRow
          icon="options-outline"
          label="模型与账号"
          detail={modelCount ? `${modelCount} 个模型` : undefined}
          onPress={onModels}
          testID="settings-models"
        />
        <SettingsRow
          icon="phone-portrait-outline"
          label="本机执行"
          separator
          detail={
            status.state === 'running'
              ? '已就绪'
              : status.state === 'starting'
                ? '准备中'
                : status.supported
                  ? '未启动'
                  : '暂不支持'
          }
          onPress={onExecution}
          testID="settings-local-execution"
        />
      </SettingsGroup>
      <SettingsGroup title="账号">
        <SettingsRow
          icon="cloud-outline"
          label={auth.user ? 'Wegent 账号' : '登录 Wegent'}
          detail={auth.user?.user_name}
          onPress={onBackend}
          testID="settings-backend"
        />
      </SettingsGroup>
      <SettingsGroup title="隐私">
        <TelemetryPrivacySettings />
        <SettingsRow
          icon="shield-checkmark-outline"
          label="隐私政策"
          onPress={onPrivacy}
          testID="settings-privacy-policy"
        />
      </SettingsGroup>
      <SettingsGroup title="诊断">
        <DiagnosticsSettings />
      </SettingsGroup>
      {providers.error != null && (
        <ErrorNotice
          error={providers.error}
          onRetry={providers.retry}
          testID="settings-providers-error"
        />
      )}
      {(error != null || localError != null) && (
        <ErrorNotice error={error ?? localError} title="本机设置需要处理" testID="settings-error" />
      )}
    </SettingsPage>
  )
}

export function LocalExecutionScreen({
  runtime,
  status,
  error,
  onRetry,
  onBack,
  onChanged,
  profiles,
  onSelectProfile,
  selectingProfile,
}: {
  runtime: LocalRuntime | null
  status: LocalRuntimeStatus
  error: unknown
  onRetry: () => Promise<void>
  onBack: () => void
  onChanged: () => Promise<void>
  profiles: LocalRuntimeProfile[]
  onSelectProfile: (scope: string) => Promise<void>
  selectingProfile: boolean
}) {
  const select = (scope: string) => {
    const apply = () => onSelectProfile(scope)
    if (!runtime) {
      void apply().catch(cause => showErrorAlert(cause, { title: '无法切换本机环境' }))
      return
    }
    confirmNativeAction(
      '切换本机环境',
      '当前本机执行会停止。两个环境的文件和会话都会保留，Wegent 登录不受影响。',
      { confirmLabel: '切换', onConfirm: apply }
    )
  }
  return (
    <SettingsPage title="本机执行" onBack={onBack}>
      {runtime && error != null && (
        <ErrorNotice error={error} onRetry={onRetry} testID="local-startup-error" />
      )}
      {runtime ? (
        <LocalRuntimeSettings
          runtime={runtime}
          status={status}
          visible
          onChanged={onChanged}
          section="execution"
        />
      ) : error ? (
        <ErrorNotice error={error} onRetry={onRetry} testID="local-profile-error" />
      ) : (
        <ActivityIndicator />
      )}
      {profiles.length > 1 && (
        <SettingsGroup title="保留的本机环境">
          <Text style={styles.accountDetails}>
            选择要继续使用的环境。环境之间不会合并文件或会话。
          </Text>
          {profiles.map((profile, index) => (
            <SettingsAction
              key={profile.accountScope}
              testID={`local-profile-${profile.accountScope}`}
              secondary
              disabled={selectingProfile || runtime?.accountScope === profile.accountScope}
              onPress={() => select(profile.accountScope)}
            >
              {`环境 ${index + 1} · ${profile.accountScope.slice(0, 8)} · ${new Date(profile.modifiedAt).toLocaleString()}${runtime?.accountScope === profile.accountScope ? ' · 当前' : ''}`}
            </SettingsAction>
          ))}
        </SettingsGroup>
      )}
    </SettingsPage>
  )
}

export function BackendLoginScreen({
  auth,
  onClose,
}: {
  auth: WegentAuthState
  onClose: () => void
}) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [error, setError] = useState<unknown>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => () => auth.cancelLogin(), [auth.cancelLogin])
  if (auth.user && auth.config)
    return (
      <SettingsPage title="Wegent 账号" onBack={onClose}>
        <SettingsGroup title="已连接">
          <View style={styles.accountDetails}>
            <Text variant="titleMedium">{auth.user.full_name || auth.user.user_name}</Text>
            <Text selectable variant="bodyMedium">
              {auth.config.backendUrl}
            </Text>
          </View>
        </SettingsGroup>
        <SettingsAction
          testID="disconnect-backend"
          secondary
          onPress={() => {
            void auth
              .logout()
              .then(() => {
                if (mounted.current) onClose()
              })
              .catch(cause => setError(cause))
          }}
        >
          退出 Wegent 登录
        </SettingsAction>
        {error != null && <ErrorNotice error={error} testID="backend-logout-error" />}
      </SettingsPage>
    )
  return (
    <View style={[styles.screen, { backgroundColor: theme.colors.background }]}>
      <AuthorizationScreen
        {...auth}
        backendUrl={auth.backendUrl}
        onBackendUrlChange={auth.setBackendUrl}
        onAuthorize={auth.login}
      />
      <View style={[styles.loginClose, { top: insets.top + 8 }]}>
        <SettingsIcon
          name="close"
          label="关闭登录"
          onPress={() => {
            auth.cancelLogin()
            onClose()
          }}
          testID="backend-login-close"
          filled
        />
      </View>
    </View>
  )
}

export const settingsStyles = StyleSheet.create({
  groupContent: { paddingHorizontal: 20, paddingBottom: 16, gap: 8 },
  groupText: { paddingHorizontal: 20, paddingVertical: 16 },
  field: { gap: 8 },
  form: { gap: 20 },
  hint: { opacity: 0.65 },
})

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { flexGrow: 1, paddingHorizontal: 20, gap: 20 },
  header: { minHeight: 48, flexDirection: 'row', alignItems: 'center' },
  closeHeader: { justifyContent: 'flex-end' },
  title: { flex: 1, textAlign: 'center' },
  icon: {
    minWidth: 48,
    minHeight: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profile: { minHeight: 124, alignItems: 'center', justifyContent: 'center', gap: 8 },
  intro: {
    borderRadius: 28,
    padding: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginBottom: 12,
  },
  introCopy: { flex: 1, minWidth: 0, gap: 5 },
  section: { gap: 10 },
  sectionTitle: { marginHorizontal: 20 },
  group: { borderRadius: 26, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: 62,
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  rowLabel: { flex: 1 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 56, marginRight: 20 },
  action: {
    borderRadius: 24,
    paddingHorizontal: 20,
    paddingVertical: 14,
    minHeight: 48,
    justifyContent: 'center',
    alignItems: 'center',
  },
  accountDetails: { padding: 20, gap: 10 },
  loginClose: { position: 'absolute', right: 20 },
})
