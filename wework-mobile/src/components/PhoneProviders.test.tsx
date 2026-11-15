import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PhoneProviderEditorScreen } from './PhoneProviderEditorScreen'
import { PhoneModelEditorScreen } from './PhoneModelEditorScreen'
import { PhoneProviderScreen } from './PhoneProviderScreen'
import { createDefaultLocalModelCatalogEntry } from '../../../wework/src/features/model-settings/localModelCatalog'
import { phoneModelProviders } from '@/services/phoneModelProviders'
import type { LocalRuntime } from '@/services/localRuntime'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const state = vi.hoisted(() => ({
  values: new Map<string, string>(),
  id: 0,
  guard: vi.fn(),
  confirm: vi.fn(),
  dispatch: vi.fn(),
}))
vi.mock('expo-crypto', () => ({ randomUUID: () => `model-${++state.id}` }))
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => state.values.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    state.values.set(key, value)
  },
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only',
}))
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ dispatch: state.dispatch }),
  usePreventRemove: state.guard,
}))
vi.mock('react-native', () => ({
  View: 'View',
  TextInput: 'TextInput',
  Switch: 'Switch',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (s: unknown) => s },
}))
vi.mock('react-native-paper', () => ({ Text: 'Text', useTheme: () => ({ colors: {} }) }))
vi.mock('@/services/privacyPolicy', () => ({
  confirmModelDataSharing: (action: () => Promise<void>) => action(),
}))
vi.mock('@/services/errorAlerts', () => ({
  confirmNativeAction: state.confirm,
  showErrorAlert: vi.fn(),
}))
vi.mock('./SettingsScreen', () => ({
  SettingsPage: 'SettingsPage',
  SettingsGroup: 'SettingsGroup',
  SettingsAction: 'SettingsAction',
  SettingsRow: 'SettingsRow',
  settingsStyles: {},
}))
vi.mock('./errors/ErrorNotice', () => ({ ErrorNotice: 'ErrorNotice' }))
vi.mock('./ModelPrivacyNotice', () => ({ ModelPrivacyNotice: 'ModelPrivacyNotice' }))
let renderer: ReactTestRenderer
const control = (id: string) =>
  renderer.root.findAll(
    node => typeof node.type === 'string' && (node.props.testID === id || node.props.id === id)
  )[0]!
const callbacks = () => ({
  onBack: vi.fn(),
  onChanged: vi.fn().mockResolvedValue(undefined),
  onPrivacy: vi.fn(),
})
const seed = async () =>
  phoneModelProviders.saveProvider(
    {
      id: 'service',
      name: 'Work',
      base_url: 'https://proxy.test/v1',
      api_format: 'openai-responses',
      api_key: 'stored-key',
      models: [
        {
          id: 'stable',
          model_id: 'upstream-a',
          display_name: 'Reasoning',
          context_window: 128000,
          catalog_entry: {
            ...createDefaultLocalModelCatalogEntry({
              id: 'stable',
              displayName: 'Reasoning',
              toolProfile: 'function',
              contextWindow: 128000,
            }),
            default_reasoning_level: 'high',
          },
        },
      ],
    },
    (await phoneModelProviders.providers()).revision
  )
beforeEach(() => {
  state.values.clear()
  state.id = 0
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})
afterEach(async () => {
  if (renderer) await act(() => renderer.unmount())
})

it('saves a named provider with zero models and retains independent configuration bytes', async () => {
  state.values.set('wework.mobile.responses-models.v1', '["untouched"]')
  const onSaved = vi.fn()
  const props = callbacks()
  await act(() => {
    renderer = create(<PhoneProviderEditorScreen {...props} runtime={null} onSaved={onSaved} />)
  })
  await act(() => control('provider-preset-deepseek').props.onPress())
  await act(() => control('provider-name').props.onChangeText('Personal DeepSeek'))
  await act(() => control('provider-api-key').props.onChangeText('new-key'))
  await act(() => control('provider-save').props.onPress())
  expect(onSaved).toHaveBeenCalledOnce()
  const snapshot = await phoneModelProviders.providers()
  expect(snapshot.providers[0]).toMatchObject({
    name: 'Personal DeepSeek',
    api_key_configured: true,
    models: [],
  })
  expect(JSON.stringify(snapshot)).not.toContain('new-key')
  expect(state.values.get('wework.mobile.responses-models.v1')).toBe('["untouched"]')
})
it('edits a model without rendering or replacing provider credentials', async () => {
  await seed()
  const props = callbacks()
  await act(() => {
    renderer = create(
      <PhoneModelEditorScreen {...props} providerId="service" modelId="stable" runtime={null} />
    )
  })
  expect(control('provider-api-key')).toBeUndefined()
  await act(() => control('local-model-displayName').props.onChangeText('Renamed'))
  await act(() => control('local-model-save').props.onPress())
  const provider = (await phoneModelProviders.providers()).providers[0]
  expect(provider.models[0]).toMatchObject({
    id: 'stable',
    display_name: 'Renamed',
    context_window: 128000,
    catalog_entry: { default_reasoning_level: 'high' },
  })
  expect(provider.api_key_configured).toBe(true)
  expect(props.onBack).toHaveBeenCalledOnce()
})
it('retries runtime synchronization without duplicating a newly saved model', async () => {
  await seed()
  const props = callbacks()
  const runtime = {
    status: { state: 'running' },
    request: vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ restarted: true }),
  } as unknown as LocalRuntime
  await act(() => {
    renderer = create(<PhoneModelEditorScreen {...props} providerId="service" runtime={runtime} />)
  })
  await act(() => control('local-model-modelId').props.onChangeText('new-upstream'))
  await act(() => control('local-model-save').props.onPress())
  expect(props.onBack).not.toHaveBeenCalled()
  expect(control('local-model-error')).toBeDefined()
  await act(() => control('local-model-save').props.onPress())
  expect(
    (await phoneModelProviders.providers()).providers[0].models.map(model => model.model_id)
  ).toEqual(['upstream-a', 'new-upstream'])
  expect(props.onBack).toHaveBeenCalledOnce()
})
it('preserves malformed JSON text until explicit apply and supports recovery', async () => {
  await seed()
  const props = callbacks()
  await act(() => {
    renderer = create(
      <PhoneModelEditorScreen {...props} providerId="service" modelId="stable" runtime={null} />
    )
  })
  await act(() => control('local-model-advanced').props.onPress())
  await act(() => control('local-model-catalog-toggle').props.onPress())
  await act(() => control('local-model-catalog').props.onChangeText('{broken'))
  await act(() => control('local-model-catalog-apply').props.onPress())
  expect(control('local-model-catalog').props.value).toBe('{broken')
  expect(control('local-model-save').props.disabled).toBe(true)
  expect((await phoneModelProviders.providers()).providers[0].models[0].catalog_entry?.slug).toBe(
    'wework-custom-stable'
  )
  await act(() => control('local-model-catalog-cancel').props.onPress())
  expect(control('local-model-save').props.disabled).toBe(false)
})
it('searches, discovers, adds and hides models while preserving existing overrides', async () => {
  await seed()
  const props = callbacks()
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: 'upstream-a' }, { id: 'new-upstream' }] }))
      )
  )
  await act(() => {
    renderer = create(
      <PhoneProviderScreen
        {...props}
        providerId="service"
        runtime={null}
        onEditConnection={vi.fn()}
        onAddModel={vi.fn()}
        onEditModel={vi.fn()}
      />
    )
  })
  await act(() => control('provider-model-search').props.onChangeText('reasoning'))
  expect(control('settings-model-stable')).toBeDefined()
  await act(() => control('provider-model-search').props.onChangeText(''))
  await act(() => control('provider-discover').props.onPress())
  expect(control('provider-discovered-upstream-a')).toBeUndefined()
  await act(() => control('provider-discovered-new-upstream').props.onPress())
  await act(() => control('provider-model-enabled-stable').props.onValueChange(false))
  const provider = (await phoneModelProviders.providers()).providers[0]
  expect(provider.models).toHaveLength(2)
  expect(provider.models[0]).toMatchObject({
    id: 'stable',
    context_window: 128000,
    enabled: false,
    catalog_entry: { default_reasoning_level: 'high' },
  })
})
it('guards native back navigation with the actual unsaved draft', async () => {
  await seed()
  const props = callbacks()
  await act(() => {
    renderer = create(
      <PhoneModelEditorScreen {...props} providerId="service" modelId="stable" runtime={null} />
    )
  })
  expect(state.guard.mock.lastCall?.[0]).toBe(false)
  await act(() => control('local-model-displayName').props.onChangeText('Unsaved'))
  expect(state.guard.mock.lastCall?.[0]).toBe(true)
  await act(() => state.guard.mock.lastCall?.[1]({ data: { action: { type: 'GO_BACK' } } }))
  expect(state.confirm).toHaveBeenCalledOnce()
  expect(state.dispatch).not.toHaveBeenCalled()
  await act(() => state.confirm.mock.lastCall?.[2].onConfirm())
  expect(state.dispatch).toHaveBeenCalledWith({ type: 'GO_BACK' })
  expect((await phoneModelProviders.providers()).providers[0].models[0].display_name).toBe(
    'Reasoning'
  )
})

it('allows leaving read-only discovery and aborts its abandoned request', async () => {
  await seed()
  const props = callbacks()
  let aborted = false
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(new Error('Aborted'))
            },
            { once: true }
          )
        })
    )
  )
  await act(() => {
    renderer = create(
      <PhoneProviderScreen
        {...props}
        providerId="service"
        runtime={null}
        onEditConnection={vi.fn()}
        onAddModel={vi.fn()}
        onEditModel={vi.fn()}
      />
    )
  })
  await act(async () => {
    void control('provider-discover').props.onPress()
  })
  expect(control('provider-discover').props.disabled).toBe(true)
  expect(state.guard.mock.lastCall?.[0]).toBe(false)
  await act(() => renderer.unmount())
  expect(aborted).toBe(true)
})

it.each(['openai-chat-completions', 'anthropic-messages'] as const)(
  'adds a custom %s model using compatible tools',
  async api_format => {
    await phoneModelProviders.saveProvider(
      {
        id: 'service',
        name: 'Custom',
        base_url: 'https://example.test/v1',
        api_format,
        models: [],
      },
      (await phoneModelProviders.providers()).revision
    )
    const props = callbacks()
    await act(() => {
      renderer = create(<PhoneModelEditorScreen {...props} providerId="service" runtime={null} />)
    })
    await act(() => control('local-model-modelId').props.onChangeText('upstream'))
    await act(() => control('local-model-save').props.onPress())
    expect(props.onBack).toHaveBeenCalledOnce()
    expect((await phoneModelProviders.providers()).providers[0].models[0]).toMatchObject({
      model_id: 'upstream',
      tool_profile: 'function',
    })
  }
)
