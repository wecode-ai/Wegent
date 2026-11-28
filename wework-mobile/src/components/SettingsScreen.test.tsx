import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsScreen, BackendLoginScreen, LocalExecutionScreen } from './SettingsScreen'
import { PhoneStandaloneModelEditorScreen } from './PhoneStandaloneModelEditorScreen'
import { PrivacyPolicyScreen } from './PrivacyPolicyScreen'
import policies from '@/content/mobilePrivacyPolicy.json'
import type { WegentAuthState } from '@/auth/useWegentAuth'
import type { LocalRuntime } from '@/services/localRuntime'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const stored = vi.hoisted(() => ({ raw: null as string | null, id: 0 }))
const environment = vi.hoisted(() => ({ platform: 'ios' }))
const privacy = vi.hoisted(() => ({
  open: vi.fn(async () => undefined),
  confirm: vi.fn<(action: () => Promise<void>) => void>(action => {
    void action()
  }),
}))
vi.mock('@/services/privacyPolicy', () => ({
  MODEL_DATA_SHARING_NOTICE: '消息、附件和任务文件会发送给所选模型服务。',
  openPrivacyPolicy: privacy.open,
  confirmModelDataSharing: privacy.confirm,
}))
vi.mock('expo-crypto', () => ({ randomUUID: () => `model-${++stored.id}` }))
vi.mock('expo-secure-store', () => ({
  getItemAsync: async () => stored.raw,
  setItemAsync: async (_key: string, raw: string) => {
    stored.raw = raw
  },
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only',
}))
vi.mock('@/services/phoneModelProviders', () => ({
  phoneModelProviders: {
    runtimeConfiguration: vi.fn(async () => ({ models: [], catalogByModel: new Map() })),
    providers: vi.fn(async () => ({ revision: 'empty', providers: [] })),
    subscribe: () => () => {},
  },
}))
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }))
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return environment.platform
    },
  },
  View: 'View',
  TextInput: 'TextInput',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 0.5 },
}))
vi.mock('react-native-paper', () => ({
  Button: 'Button',
  Text: 'Text',
  useTheme: () => ({ colors: {} }),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, bottom: 34 }),
}))
vi.mock('react-native-keyboard-controller', () => ({
  KeyboardAwareScrollView: 'KeyboardAwareScrollView',
}))
vi.mock('./AuthorizationScreen', () => ({ AuthorizationScreen: 'AuthorizationScreen' }))
vi.mock('./LocalRuntimeSettings', () => ({ LocalRuntimeSettings: 'LocalRuntimeSettings' }))
vi.mock('./DiagnosticsSettings', () => ({ DiagnosticsSettings: 'DiagnosticsSettings' }))
vi.mock('./TelemetryPrivacySettings', () => ({
  TelemetryPrivacySettings: 'TelemetryPrivacySettings',
}))
vi.mock('./errors/ErrorNotice', () => ({ ErrorNotice: 'ErrorNotice' }))
vi.mock('@/services/errorAlerts', () => ({ confirmNativeAction: vi.fn(), showErrorAlert: vi.fn() }))

const status = {
  supported: true,
  state: 'running' as const,
  background: 'notRequested' as const,
  generation: 1,
}
function auth(user: WegentAuthState['user'] = null): WegentAuthState {
  return {
    user,
    config: user
      ? {
          backendUrl: 'https://backend',
          apiBaseUrl: 'https://backend/api',
          accessToken: 'token',
          socketBaseUrl: 'https://backend',
          socketPath: '/socket.io',
        }
      : null,
    backend: null,
    backendUrl: '',
    status: user ? 'authenticated' : 'unauthenticated',
    error: null,
    login: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    cancelLogin: vi.fn(),
    refresh: vi.fn(),
    setBackendUrl: vi.fn(),
  }
}
describe('full-page local settings', () => {
  let renderer: ReactTestRenderer
  const control = (testID: string) =>
    renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === testID)[0]!
  beforeEach(() => {
    stored.raw = null
    stored.id = 0
    environment.platform = 'ios'
    privacy.open.mockClear()
    privacy.confirm.mockClear()
  })
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
  })
  it.each(['ios', 'android'])(
    'keeps settings actions reachable with platform keyboard dismissal on %s',
    async platform => {
      environment.platform = platform
      const onClose = vi.fn()
      const onModels = vi.fn()
      const onBackend = vi.fn()
      const onPrivacy = vi.fn()
      await act(() => {
        renderer = create(
          <SettingsScreen
            auth={auth()}
            status={status}
            localError={null}
            onClose={onClose}
            onModels={onModels}
            onBackend={onBackend}
            onExecution={vi.fn()}
            onPrivacy={onPrivacy}
          />
        )
      })
      expect(control('settings-page-scroll').props.keyboardDismissMode).toBe(
        platform === 'ios' ? 'interactive' : 'on-drag'
      )
      expect(control('settings-page-scroll').props.keyboardShouldPersistTaps).toBe('handled')
      expect(renderer.root.findAllByType('Dialog' as never)).toHaveLength(0)
      await act(() => control('settings-models').props.onPress())
      await act(() => control('settings-backend').props.onPress())
      await act(() => control('settings-privacy-policy').props.onPress())
      await act(() => control('close-settings').props.onPress())
      expect(onModels).toHaveBeenCalledOnce()
      expect(onBackend).toHaveBeenCalledOnce()
      expect(onClose).toHaveBeenCalledOnce()
      expect(onPrivacy).toHaveBeenCalledOnce()
      expect(privacy.open).not.toHaveBeenCalled()
    }
  )
  it.each(['zh', 'en'] as const)(
    'reads the complete %s privacy policy offline with native scrolling',
    async language => {
      const onBack = vi.fn()
      await act(() => {
        renderer = create(<PrivacyPolicyScreen onBack={onBack} />)
      })
      await act(() => control(`privacy-language-${language}`).props.onPress())
      const policy = policies[language]
      const text = renderer.root.findAllByType('Text' as never)
      for (const paragraph of [
        ...policy.introduction,
        ...policy.sections.flatMap(section => section.paragraphs),
      ]) {
        const node = text.find(value => value.props.children === paragraph)
        expect(node?.props.selectable).toBe(true)
      }
      for (const heading of [policy.title, ...policy.sections.map(section => section.title)]) {
        expect(text.find(value => value.props.children === heading)?.props.accessibilityRole).toBe(
          'header'
        )
      }
      expect(control('settings-page-scroll')).toBeDefined()
      expect(privacy.open).not.toHaveBeenCalled()
      await act(() => control('privacy-public-version').props.onPress())
      expect(privacy.open).toHaveBeenCalledExactlyOnceWith(language)
      await act(() => control('settings-back').props.onPress())
      expect(onBack).toHaveBeenCalledOnce()
    }
  )

  it('closes optional Backend authorization by cancelling only that login', async () => {
    const session = auth()
    const onClose = vi.fn()
    await act(() => {
      renderer = create(<BackendLoginScreen auth={session} onClose={onClose} />)
    })
    await act(() => control('backend-login-close').props.onPress())
    expect(session.cancelLogin).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
    expect(session.logout).not.toHaveBeenCalled()
  })
  it('logs out of Backend without taking ownership of the local runtime', async () => {
    const session = auth({ id: 2, user_name: 'cloud-user' })
    const onClose = vi.fn()
    await act(() => {
      renderer = create(<BackendLoginScreen auth={session} onClose={onClose} />)
    })
    await act(() => control('disconnect-backend').props.onPress())
    expect(session.logout).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })
  it('shows every preserved environment while the local capability awaits a choice', async () => {
    const select = vi.fn().mockResolvedValue(undefined)
    const profiles = [
      { accountScope: 'a'.repeat(64), modifiedAt: 1000 },
      { accountScope: 'b'.repeat(64), modifiedAt: 2000 },
    ]
    await act(() => {
      renderer = create(
        <LocalExecutionScreen
          runtime={null}
          status={status}
          error={new Error('choose')}
          onRetry={vi.fn()}
          onBack={vi.fn()}
          onChanged={vi.fn()}
          profiles={profiles}
          onSelectProfile={select}
          selectingProfile={false}
        />
      )
    })
    await act(() => control(`local-profile-${profiles[1].accountScope}`).props.onPress())
    expect(select).toHaveBeenCalledWith(profiles[1].accountScope)
  })
  it.each(['ios', 'android'])(
    'keeps the model form and retry reachable across keyboard dismissal on %s',
    async platform => {
      environment.platform = platform
      const runtime = {
        status,
        request: vi
          .fn()
          .mockRejectedValueOnce(new Error('runtime unavailable'))
          .mockResolvedValue({}),
      } as unknown as LocalRuntime
      const onBack = vi.fn()
      await act(() => {
        renderer = create(
          <PhoneStandaloneModelEditorScreen
            runtime={runtime}
            onBack={onBack}
            onChanged={vi.fn()}
            onPrivacy={vi.fn()}
          />
        )
      })
      expect(control('settings-form-scroll').type).toBe('KeyboardAwareScrollView')
      expect(control('settings-form-scroll').props.keyboardDismissMode).toBe(
        platform === 'ios' ? 'interactive' : 'on-drag'
      )
      expect(control('settings-form-scroll').props.keyboardShouldPersistTaps).toBe('handled')
      await act(() => control('local-model-modelId').props.onChangeText('test-model'))
      await act(() => control('local-model-save').props.onPress())
      expect(onBack).not.toHaveBeenCalled()
      expect(control('local-model-modelId').props.value).toBe('test-model')
      expect(control('local-model-error')).toBeDefined()
      await act(() => control('local-model-save').props.onPress())
      expect(JSON.parse(stored.raw!)).toHaveLength(1)
      expect(onBack).toHaveBeenCalledOnce()
    }
  )

  it('preserves the draft and stored models when sharing confirmation is cancelled', async () => {
    const runtime = { status, request: vi.fn().mockResolvedValue({}) } as unknown as LocalRuntime
    const onBack = vi.fn()
    const onPrivacy = vi.fn()
    privacy.confirm.mockImplementationOnce(() => undefined)
    await act(() => {
      renderer = create(
        <PhoneStandaloneModelEditorScreen
          runtime={runtime}
          onBack={onBack}
          onChanged={vi.fn()}
          onPrivacy={onPrivacy}
        />
      )
    })
    await act(() => control('local-model-modelId').props.onChangeText('test-model'))
    await act(() => control('local-model-save').props.onPress())
    expect(stored.raw).toBeNull()
    expect(runtime.request).not.toHaveBeenCalled()
    expect(onBack).not.toHaveBeenCalled()
    expect(control('local-model-modelId').props.value).toBe('test-model')
    await act(() => control('local-model-privacy-read').props.onPress())
    expect(onPrivacy).toHaveBeenCalledOnce()
    expect(stored.raw).toBeNull()
  })

  it('does not navigate again if the editor was closed while a save was synchronizing', async () => {
    let complete!: () => void
    const pending = new Promise<void>(resolve => {
      complete = resolve
    })
    const runtime = {
      status,
      request: vi.fn().mockReturnValueOnce(pending).mockResolvedValue({}),
    } as unknown as LocalRuntime
    const onBack = vi.fn()
    await act(() => {
      renderer = create(
        <PhoneStandaloneModelEditorScreen
          runtime={runtime}
          onBack={onBack}
          onChanged={vi.fn()}
          onPrivacy={vi.fn()}
        />
      )
    })
    await act(() => control('local-model-modelId').props.onChangeText('test-model'))
    await act(() => control('local-model-save').props.onPress())
    await act(() => renderer.unmount())
    await act(() => complete())
    expect(onBack).not.toHaveBeenCalled()
    expect(JSON.parse(stored.raw!)).toHaveLength(1)
  })
})
