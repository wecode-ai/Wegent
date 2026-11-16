import * as Crypto from 'expo-crypto'
import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { Text } from 'react-native-paper'
import { phoneModelProviders, type ProviderModel } from '@/services/phoneModelProviders'
import type { LocalRuntime } from '@/services/localRuntime'
import { confirmNativeAction } from '@/services/errorAlerts'
import { confirmModelDataSharing } from '@/services/privacyPolicy'
import {
  createPresetProviderModel,
  detectProviderPreset,
} from '../../../wework/src/features/model-settings/providerPresets'
import {
  SettingsAction,
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  settingsStyles,
} from './SettingsScreen'
import {
  ProviderField,
  ProviderToggle,
  usePhoneProviderDraft,
  usePhoneProviderOperation,
  useProviderDraftGuard,
} from './PhoneProviderForms'
import { ErrorNotice } from './errors/ErrorNotice'
import { ModelPrivacyNotice } from './ModelPrivacyNotice'

export function PhoneProviderScreen({
  providerId,
  runtime,
  onBack,
  onChanged,
  onEditConnection,
  onAddModel,
  onEditModel,
  onPrivacy,
}: {
  providerId: string
  runtime: LocalRuntime | null
  onBack: () => void
  onChanged: () => Promise<void>
  onEditConnection: () => void
  onAddModel: () => void
  onEditModel: (id: string) => void
  onPrivacy: () => void
}) {
  const state = usePhoneProviderDraft(providerId)
  const operation = usePhoneProviderOperation(runtime, onChanged)
  const [deleted, setDeleted] = useState(false)
  const [search, setSearch] = useState('')
  const [candidates, setCandidates] = useState<string[] | null>(null)
  const [tested, setTested] = useState<string | null>(null)
  const discovery = useRef<AbortController | null>(null)
  const draft = state.draft
  const finish = useProviderDraftGuard(false, operation.writing, onBack)
  useEffect(() => phoneModelProviders.subscribe(state.retry), [state.retry])
  useEffect(() => () => discovery.current?.abort(), [])
  const updateModels = (models: ProviderModel[]) =>
    operation.act(async () => {
      if (!draft) return
      await state.persist({ ...draft, models })
      await operation.synchronize()
    })
  const discover = () =>
    operation.act(
      async () => {
        if (!draft) return
        discovery.current?.abort()
        const controller = new AbortController()
        discovery.current = controller
        const result = await phoneModelProviders.discover(draft, controller.signal)
        if (operation.mounted.current) setCandidates(result)
      },
      { readOnly: true }
    )
  const test = (id: string) =>
    operation.act(
      async () => {
        if (!draft) return
        setTested(null)
        await phoneModelProviders.test(
          { ...draft, models: draft.models.filter(model => model.id === id) },
          id
        )
        if (operation.mounted.current) setTested(id)
      },
      { readOnly: true }
    )
  const remove = () =>
    confirmNativeAction(
      '删除服务商',
      `删除“${draft?.name}”及其 ${draft?.models.length ?? 0} 个模型配置？已有会话仍会保留，继续使用前需要重新选择模型。`,
      {
        confirmLabel: '删除',
        destructive: true,
        onConfirm: () =>
          operation.act(async () => {
            if (!state.captured.current) return
            await phoneModelProviders.removeProvider(providerId, state.captured.current.revision)
            if (operation.mounted.current) setDeleted(true)
            await operation.synchronize()
            if (operation.mounted.current) finish()
          }),
      }
    )
  const matches = (text: string) => text.toLowerCase().includes(search.toLowerCase())
  const models =
    draft?.models.filter(model => matches(`${model.model_id} ${model.display_name ?? ''}`)) ?? []
  const available = candidates?.filter(
    id => matches(id) && !draft?.models.some(model => model.model_id === id)
  )
  return (
    <SettingsPage title={draft?.name ?? '服务商'} onBack={onBack} keyboard>
      {state.loading && <ActivityIndicator />}
      <ModelPrivacyNotice testID="provider-models-privacy" onReadPolicy={onPrivacy} />
      {draft && !deleted && (
        <>
          <SettingsGroup title="服务连接">
            <SettingsRow
              testID="provider-edit-connection"
              disabled={operation.busy || state.loading}
              icon="options-outline"
              label="编辑服务连接"
              onPress={onEditConnection}
            />
          </SettingsGroup>
          <Text variant="bodySmall" selectable style={settingsStyles.hint}>
            {draft.base_url} · {draft.api_format}
            {draft.enabled === false ? ' · 已停用' : ''} ·{' '}
            {draft.api_key_configured ? '密钥已配置' : '未配置密钥'}
          </Text>
          <ProviderField
            id="provider-model-search"
            label="搜索模型"
            value={search}
            onChange={setSearch}
            placeholder="模型 ID 或名称"
          />
          <SettingsAction
            testID="provider-discover"
            disabled={operation.busy || state.loading}
            secondary
            onPress={() => confirmModelDataSharing(discover)}
          >
            {operation.busy ? '处理中…' : '获取 / 刷新模型列表'}
          </SettingsAction>
          <SettingsAction
            testID="provider-model-add"
            disabled={operation.busy || state.loading}
            onPress={onAddModel}
          >
            手动添加模型
          </SettingsAction>
          <SettingsGroup title={`已配置模型（${draft.models.length}）`}>
            {models.map((model, index) => (
              <View key={model.id}>
                <SettingsRow
                  testID={`settings-model-${model.id}`}
                  disabled={operation.busy || state.loading}
                  icon="cube-outline"
                  label={model.display_name || model.model_id}
                  separator={index > 0}
                  onPress={() => onEditModel(model.id)}
                />
                <View style={settingsStyles.groupContent}>
                  {model.display_name && model.display_name !== model.model_id && (
                    <Text selectable style={settingsStyles.hint}>
                      {model.model_id}
                    </Text>
                  )}
                  <ProviderToggle
                    id={`provider-model-enabled-${model.id}`}
                    label="在模型选择器中显示"
                    value={model.enabled !== false}
                    disabled={operation.busy || state.loading}
                    onChange={enabled =>
                      void updateModels(
                        draft.models.map(row => (row.id === model.id ? { ...row, enabled } : row))
                      )
                    }
                  />
                  <SettingsAction
                    testID={`provider-model-test-${model.id}`}
                    secondary
                    disabled={operation.busy || state.loading}
                    onPress={() => confirmModelDataSharing(() => test(model.id))}
                  >
                    测试此模型
                  </SettingsAction>
                  {tested === model.id && (
                    <Text testID="provider-model-test-success">连接成功，工具调用验证通过。</Text>
                  )}
                </View>
              </View>
            ))}
            {!models.length && (
              <Text style={settingsStyles.groupText}>
                {search ? '没有匹配的已配置模型' : '尚未添加模型，可从服务获取或手动添加。'}
              </Text>
            )}
          </SettingsGroup>
          {candidates !== null && (
            <SettingsGroup title="服务返回的其他模型">
              {available?.map((id, index) => (
                <SettingsRow
                  key={id}
                  testID={`provider-discovered-${id}`}
                  disabled={operation.busy || state.loading}
                  icon="add"
                  label={id}
                  separator={index > 0}
                  onPress={() => {
                    const model = createPresetProviderModel(detectProviderPreset(draft), id, {
                      createId: Crypto.randomUUID,
                      apiFormat: draft.api_format,
                    })
                    void updateModels([...draft.models, model])
                  }}
                />
              ))}
              {!available?.length && (
                <Text style={settingsStyles.groupText}>
                  {candidates.length
                    ? '所有匹配模型均已添加，或没有搜索结果。'
                    : '服务未返回模型，仍可手动添加。'}
                </Text>
              )}
            </SettingsGroup>
          )}
          <SettingsAction
            testID="provider-delete"
            secondary
            disabled={operation.busy || state.loading}
            onPress={remove}
          >
            删除服务商
          </SettingsAction>
        </>
      )}
      {(state.error ?? operation.error) != null && (
        <ErrorNotice
          error={operation.error ?? state.error}
          onRetry={
            deleted
              ? () =>
                  operation.act(async () => {
                    await operation.synchronize()
                    if (operation.mounted.current) finish()
                  })
              : state.error
                ? state.retry
                : undefined
          }
          title="模型配置未完成"
          testID="provider-models-error"
        />
      )}
    </SettingsPage>
  )
}
