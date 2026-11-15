import * as Crypto from 'expo-crypto'
import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { Text } from 'react-native-paper'
import {
  phoneModelProviders,
  phoneModelRequestUrl,
  type ProviderModel,
  type ModelApiFormat,
} from '@/services/phoneModelProviders'
import type { LocalRuntime } from '@/services/localRuntime'
import { confirmNativeAction } from '@/services/errorAlerts'
import { confirmModelDataSharing } from '@/services/privacyPolicy'
import {
  createPresetProviderModel,
  detectProviderPreset,
} from '../../../wework/src/features/model-settings/providerPresets'
import {
  createDefaultLocalModelCatalogEntry,
  normalizeLocalModelCatalogEntry,
} from '../../../wework/src/features/model-settings/localModelCatalog'
import { localModelSupportsImageInput } from '../../../wework/src/features/model-settings/localModelProviders'
import { SettingsAction, SettingsPage, settingsStyles } from './SettingsScreen'
import {
  ProviderChoices,
  ProviderField,
  ProviderToggle,
  usePhoneProviderDraft,
  usePhoneProviderOperation,
  useProviderDraftGuard,
} from './PhoneProviderForms'
import { ErrorNotice } from './errors/ErrorNotice'
import { ModelPrivacyNotice } from './ModelPrivacyNotice'

export function PhoneModelEditorScreen({
  providerId,
  modelId,
  runtime,
  onBack,
  onChanged,
  onPrivacy,
}: {
  providerId: string
  modelId?: string
  runtime: LocalRuntime | null
  onBack: () => void
  onChanged: () => Promise<void>
  onPrivacy: () => void
}) {
  const state = usePhoneProviderDraft(providerId)
  const operation = usePhoneProviderOperation(runtime, onChanged)
  const [model, setModel] = useState<ProviderModel | null>(null)
  const [deleted, setDeleted] = useState(false)
  const [tested, setTested] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [showCatalog, setShowCatalog] = useState(false)
  const [catalogDraft, setCatalogDraft] = useState<string | null>(null)
  const [modelError, setModelError] = useState<unknown>(null)
  const initial = useRef<string | null>(null)
  const finish = useProviderDraftGuard(
    initial.current !== null &&
      (JSON.stringify(model) !== initial.current || catalogDraft !== null),
    operation.writing,
    onBack
  )
  useEffect(() => {
    if (!state.draft || initial.current !== null) return
    const row = modelId
      ? state.draft.models.find(item => item.id === modelId)
      : createPresetProviderModel(detectProviderPreset(state.draft), '', {
          createId: Crypto.randomUUID,
          apiFormat: state.draft.api_format,
        })
    if (!row) {
      setModelError(new Error('模型已被删除，请返回重新选择'))
      return
    }
    initial.current = JSON.stringify(row)
    setModel(structuredClone(row))
  }, [state.draft, modelId])
  const patch = (value: Partial<ProviderModel>) => {
    setModel(current => (current ? { ...current, ...value } : current))
    setTested(false)
  }
  const save = () =>
    operation.act(async () => {
      if (!model || !state.draft) return
      const models = state.draft.models.some(row => row.id === model.id)
        ? state.draft.models.map(row => (row.id === model.id ? model : row))
        : [...state.draft.models, model]
      await state.persist({ ...state.draft, models })
      await operation.synchronize()
      if (operation.mounted.current) finish()
    })
  const test = () =>
    operation.act(
      async () => {
        if (!model || !state.draft) return
        setTested(false)
        await phoneModelProviders.test({ ...state.draft, models: [model] }, model.id)
        if (operation.mounted.current) setTested(true)
      },
      { readOnly: true }
    )
  const remove = () =>
    confirmNativeAction(
      '删除模型',
      `删除“${model?.display_name || model?.model_id}”的本机配置？已有会话仍会保留。`,
      {
        confirmLabel: '删除',
        destructive: true,
        onConfirm: () =>
          operation.act(async () => {
            if (!state.draft) return
            await state.persist({
              ...state.draft,
              models: state.draft.models.filter(row => row.id !== modelId),
            })
            if (operation.mounted.current) setDeleted(true)
            await operation.synchronize()
            if (operation.mounted.current) finish()
          }),
      }
    )
  const format = model?.api_format ?? state.draft?.api_format ?? 'openai-responses'
  const entry =
    model?.catalog_entry ??
    (model
      ? createDefaultLocalModelCatalogEntry({
          id: model.id,
          displayName: model.display_name || model.model_id,
          toolProfile: model.tool_profile ?? 'function',
          contextWindow: model.context_window,
        })
      : {})
  const catalog = (value: Record<string, unknown>) =>
    patch({ catalog_entry: { ...entry, ...value } })
  const visionChoices =
    state.captured.current?.providers
      .filter(provider => provider.enabled !== false)
      .flatMap(provider =>
        provider.models
          .filter(
            row =>
              row.id !== model?.id &&
              row.enabled !== false &&
              localModelSupportsImageInput({
                catalogEntry: row.catalog_entry,
                providerProfileId: row.provider_profile_id,
                modelId: row.model_id,
                baseUrl: provider.base_url,
                apiFormat: row.api_format ?? provider.api_format,
              })
          )
          .map(row => ({ value: row.id, label: row.display_name || row.model_id }))
      ) ?? []
  if (
    model?.vision_model_config_id &&
    !visionChoices.some(choice => choice.value === model.vision_model_config_id)
  )
    visionChoices.push({
      value: model.vision_model_config_id,
      label: `当前配置：${model.vision_model_config_id}`,
    })
  let endpoint = ''
  try {
    if (state.draft && model) endpoint = phoneModelRequestUrl(state.draft, model)
  } catch {
    /* An unfinished address is shown by validation on save. */
  }
  return (
    <SettingsPage title={modelId ? '编辑模型' : '添加模型'} onBack={onBack} keyboard>
      <ModelPrivacyNotice testID="local-model-privacy" onReadPolicy={onPrivacy} />
      {state.loading && <ActivityIndicator />}
      {model && state.draft && !deleted && (
        <View style={settingsStyles.form}>
          <Text>服务连接：{state.draft.name}（共用地址与密钥）</Text>
          <ProviderField
            id="local-model-modelId"
            label="模型 ID"
            value={model.model_id}
            onChange={model_id => patch({ model_id })}
            disabled={operation.busy}
            placeholder="服务提供的模型 ID"
          />
          <ProviderField
            id="local-model-displayName"
            label="显示名称"
            value={model.display_name ?? ''}
            onChange={value => patch({ display_name: value || undefined })}
            disabled={operation.busy}
            placeholder="可选"
          />
          <ProviderToggle
            id="local-model-enabled"
            label="在模型选择器中显示"
            value={model.enabled !== false}
            onChange={enabled => patch({ enabled })}
            disabled={operation.busy}
          />
          <ProviderField
            id="local-model-context"
            label="上下文窗口（Token）"
            numeric
            value={model.context_window?.toString() ?? ''}
            onChange={value => {
              const context_window = value ? Number(value) : undefined
              patch({
                context_window,
                ...(model.catalog_entry
                  ? {
                      catalog_entry: {
                        ...model.catalog_entry,
                        context_window: context_window ?? 272000,
                        max_context_window: context_window ?? 272000,
                      },
                    }
                  : {}),
              })
            }}
            disabled={operation.busy}
            placeholder="使用模型默认值"
          />
          <ProviderField
            id="local-model-output"
            label="最大输出（Token）"
            numeric
            value={model.max_output_tokens?.toString() ?? ''}
            onChange={value => patch({ max_output_tokens: value ? Number(value) : undefined })}
            disabled={operation.busy}
            placeholder="使用模型默认值"
          />
          <ProviderToggle
            id="local-model-image-input"
            label="支持图片输入"
            value={
              Array.isArray(entry.input_modalities) && entry.input_modalities.includes('image')
            }
            onChange={enabled =>
              catalog({ input_modalities: enabled ? ['text', 'image'] : ['text'] })
            }
            disabled={operation.busy}
          />
          <ProviderToggle
            id="local-model-parallel-tools"
            label="并行工具调用"
            value={entry.supports_parallel_tool_calls === true}
            onChange={supports_parallel_tool_calls => catalog({ supports_parallel_tool_calls })}
            disabled={operation.busy}
          />
          <ProviderChoices
            id="local-model-web-search"
            label="网络搜索"
            value={model.web_search_mode ?? 'disabled'}
            choices={[
              { value: 'disabled', label: '关闭' },
              { value: 'cached', label: '缓存' },
              { value: 'live', label: '实时' },
            ]}
            onChange={web_search_mode => patch({ web_search_mode })}
            disabled={operation.busy}
          />
          <ProviderToggle
            id="local-model-image-generation"
            label="图片生成"
            value={model.image_generation_enabled === true}
            onChange={image_generation_enabled => patch({ image_generation_enabled })}
            disabled={operation.busy}
          />
          <SettingsAction
            testID="local-model-advanced"
            secondary
            onPress={() => setAdvanced(value => !value)}
          >
            {advanced ? '收起高级设置' : '高级设置'}
          </SettingsAction>
          {advanced && (
            <>
              <ProviderChoices<ModelApiFormat | ''>
                id="local-model-protocol"
                label="API 协议"
                value={model.api_format ?? ''}
                choices={[
                  { value: '', label: '继承服务连接' },
                  ...(
                    ['openai-responses', 'openai-chat-completions', 'anthropic-messages'] as const
                  ).map(value => ({ value, label: value })),
                ]}
                onChange={value =>
                  patch({
                    api_format: value || undefined,
                    request_path: undefined,
                    tool_profile: undefined,
                    catalog_entry: undefined,
                  })
                }
                disabled={operation.busy}
              />
              <ProviderField
                id="local-model-path"
                label="请求路径"
                value={model.request_path ?? ''}
                onChange={value => patch({ request_path: value || undefined })}
                disabled={operation.busy}
                placeholder="继承服务连接"
              />
              <ProviderChoices
                id="local-model-tools"
                label="工具格式"
                value={model.tool_profile ?? 'function'}
                choices={(format === 'openai-responses'
                  ? (['function', 'custom', 'shell'] as const)
                  : (['function', 'shell'] as const)
                ).map(value => ({ value, label: value }))}
                onChange={tool_profile => patch({ tool_profile })}
                disabled={operation.busy}
              />
              {format === 'openai-responses' && (
                <ProviderChoices
                  id="local-model-compatibility"
                  label="Codex 工具兼容性"
                  value={model.codex_tool_compatibility ?? 'standard'}
                  choices={[
                    { value: 'standard', label: '标准兼容' },
                    { value: 'native', label: '原生 Codex' },
                  ]}
                  onChange={codex_tool_compatibility => patch({ codex_tool_compatibility })}
                  disabled={operation.busy}
                />
              )}
              <ProviderChoices
                id="local-model-vision"
                label="视觉辅助模型"
                value={model.vision_model_config_id ?? ''}
                choices={[{ value: '', label: '关闭' }, ...visionChoices]}
                onChange={value => patch({ vision_model_config_id: value || undefined })}
                disabled={operation.busy}
              />
              <ProviderField
                id="local-model-group"
                label="分组（可选）"
                value={model.group ?? ''}
                onChange={value => patch({ group: value || undefined })}
                disabled={operation.busy}
              />
              <SettingsAction
                testID="local-model-catalog-toggle"
                secondary
                disabled={catalogDraft !== null}
                onPress={() => setShowCatalog(value => !value)}
              >
                {showCatalog ? '收起能力 JSON' : '编辑全部模型能力 JSON'}
              </SettingsAction>
              {showCatalog && (
                <ProviderField
                  id="local-model-catalog"
                  label="模型能力 JSON"
                  value={catalogDraft ?? JSON.stringify(entry, null, 2)}
                  multiline
                  disabled={operation.busy}
                  onChange={value => {
                    setCatalogDraft(value)
                    setModelError(null)
                  }}
                />
              )}
              {catalogDraft !== null && (
                <>
                  <SettingsAction
                    testID="local-model-catalog-apply"
                    secondary
                    onPress={() => {
                      try {
                        const parsed: unknown = JSON.parse(catalogDraft)
                        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                          throw new Error('请输入 JSON 对象')
                        patch({
                          catalog_entry: normalizeLocalModelCatalogEntry(parsed, {
                            id: model.id,
                            displayName: model.display_name || model.model_id,
                            toolProfile: model.tool_profile ?? 'function',
                            contextWindow: model.context_window,
                          }),
                        })
                        setCatalogDraft(null)
                        setModelError(null)
                      } catch (cause) {
                        setModelError(cause)
                      }
                    }}
                  >
                    应用能力 JSON
                  </SettingsAction>
                  <SettingsAction
                    testID="local-model-catalog-cancel"
                    secondary
                    onPress={() => {
                      setCatalogDraft(null)
                      setModelError(null)
                    }}
                  >
                    取消 JSON 修改
                  </SettingsAction>
                </>
              )}
            </>
          )}
          <Text
            testID="local-model-endpoint"
            selectable
            variant="bodySmall"
            style={settingsStyles.hint}
          >
            请求地址：{endpoint}
          </Text>
          {tested && (
            <Text testID="local-model-test-success">连接成功，模型工具调用验证通过。</Text>
          )}
          <SettingsAction
            testID="local-model-test"
            secondary
            disabled={operation.busy}
            onPress={() => confirmModelDataSharing(test)}
          >
            测试连接
          </SettingsAction>
          <SettingsAction
            testID="local-model-save"
            disabled={operation.busy || modelError != null || catalogDraft !== null}
            onPress={() => confirmModelDataSharing(save)}
          >
            保存模型
          </SettingsAction>
          {modelId && (
            <SettingsAction
              testID="local-model-delete"
              secondary
              disabled={operation.busy}
              onPress={remove}
            >
              删除模型
            </SettingsAction>
          )}
        </View>
      )}
      {(state.error ?? modelError ?? operation.error) != null && (
        <ErrorNotice
          error={state.error ?? modelError ?? operation.error}
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
          testID="local-model-error"
        />
      )}
    </SettingsPage>
  )
}
