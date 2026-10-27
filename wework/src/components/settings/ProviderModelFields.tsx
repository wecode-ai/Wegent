import { useTranslation } from '@/hooks/useTranslation'

import {
  type ModelProvider,
  type ProviderModel,
} from '@/features/model-settings/providerModelConfiguration'
import { defaultLocalModelToolProfile } from '@/features/model-settings/localModelSettings'
import {
  listLocalModelConfigs,
  type LocalModelWebSearchMode,
} from '@/features/model-settings/localModelSettings'
import { localModelSupportsImageInput } from '@/features/model-settings/localModelProviders'
import { createDefaultLocalModelCatalogEntry } from '@/features/model-settings/localModelCatalog'
import { CustomModelCapabilitiesForm } from './CustomModelCapabilitiesForm'

const INPUT =
  'min-h-11 w-full min-w-0 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-text-primary focus:outline-none keyboard:focus:ring-2 keyboard:focus:ring-primary/30 md:min-h-8'

const FORMATS = ['openai-responses', 'openai-chat-completions', 'anthropic-messages'] as const

/** Expose frequently edited model capabilities directly while grouping infrequent protocol controls. */
export function ProviderModelFields({
  model,
  provider,
  onChange,
}: {
  model: ProviderModel
  provider: ModelProvider
  onChange: (value: Partial<ProviderModel>) => void
}) {
  const { t } = useTranslation('modelConnections')
  const { t: common } = useTranslation('common')
  const format = model.api_format ?? provider.api_format
  const toolProfile = model.tool_profile ?? defaultLocalModelToolProfile(format)
  const entry =
    model.catalog_entry ??
    createDefaultLocalModelCatalogEntry({
      id: model.id,
      displayName: model.display_name || model.model_id,
      toolProfile,
      contextWindow: model.context_window,
    })
  return (
    <div className="space-y-3">
      <CustomModelCapabilitiesForm
        entry={entry}
        apiFormat={format}
        codexToolCompatibility={model.codex_tool_compatibility ?? 'native'}
        onCodexToolCompatibilityChange={value => onChange({ codex_tool_compatibility: value })}
        contextWindow={model.context_window?.toString() ?? ''}
        maxOutputTokens={model.max_output_tokens?.toString() ?? ''}
        onMaxOutputTokensChange={value =>
          onChange({ max_output_tokens: value ? Number(value) : undefined })
        }
        onContextWindowChange={value => {
          const context_window = value ? Number(value) : undefined
          onChange({
            context_window,
            ...(model.catalog_entry
              ? {
                  catalog_entry: {
                    ...model.catalog_entry,
                    context_window: context_window ?? 272_000,
                    max_context_window: context_window ?? 272_000,
                  },
                }
              : {}),
          })
        }}
        onChange={catalog_entry => onChange({ catalog_entry })}
      />
      <div className="grid gap-3 md:grid-cols-2">
        <label className="grid gap-1 text-sm text-text-secondary">
          {common('workbench.local_model_web_search_label')}
          <select
            data-testid={`provider-model-web-search-${model.id}`}
            className={INPUT}
            value={model.web_search_mode ?? 'disabled'}
            onChange={event =>
              onChange({ web_search_mode: event.target.value as LocalModelWebSearchMode })
            }
          >
            {(['disabled', 'cached', 'live'] as const).map(value => (
              <option key={value} value={value}>
                {common(`workbench.local_model_web_search_${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-text-secondary">
          <input
            type="checkbox"
            data-testid={`provider-model-image-generation-${model.id}`}
            checked={model.image_generation_enabled ?? false}
            onChange={event => onChange({ image_generation_enabled: event.target.checked })}
          />
          {common('workbench.local_model_image_generation_label')}
        </label>
        <label className="grid gap-1 text-sm text-text-secondary md:col-span-2">
          {common('workbench.local_model_vision_proxy_label')}
          <select
            data-testid={`provider-model-vision-${model.id}`}
            className={INPUT}
            value={model.vision_model_config_id ?? ''}
            onChange={event =>
              onChange({ vision_model_config_id: event.target.value || undefined })
            }
          >
            <option value="">{common('workbench.local_model_vision_proxy_disabled')}</option>
            {model.vision_model_config_id &&
              !listLocalModelConfigs().some(item => item.id === model.vision_model_config_id) && (
                <option value={model.vision_model_config_id}>{model.vision_model_config_id}</option>
              )}
            {listLocalModelConfigs()
              .filter(
                item => item.enabled && item.id !== model.id && localModelSupportsImageInput(item)
              )
              .map(item => (
                <option key={item.id} value={item.id}>
                  {item.displayName}
                </option>
              ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm text-text-secondary md:col-span-2">
          {common('workbench.local_model_group_label')}
          <input
            data-testid={`provider-model-group-${model.id}`}
            className={INPUT}
            value={model.group ?? ''}
            onChange={event => onChange({ group: event.target.value || undefined })}
          />
        </label>
      </div>
      <details>
        <summary className="cursor-pointer text-xs text-text-secondary">
          {t('modelAdvanced')}
        </summary>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm text-text-secondary">
            {t('protocol')}
            <select
              className={INPUT}
              data-testid={`provider-model-protocol-${model.id}`}
              value={model.api_format ?? ''}
              onChange={event =>
                onChange({
                  api_format: (event.target.value as ProviderModel['api_format']) || undefined,
                  request_path: undefined,
                  tool_profile: undefined,
                  catalog_entry: undefined,
                })
              }
            >
              <option value="">{t('inherit')}</option>
              {FORMATS.map(value => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm text-text-secondary">
            {t('requestPath')}
            <input
              className={INPUT}
              data-testid={`provider-model-path-${model.id}`}
              value={model.request_path ?? ''}
              placeholder={t('inherit')}
              onChange={event => onChange({ request_path: event.target.value || undefined })}
            />
          </label>
          <label className="space-y-1 text-sm text-text-secondary">
            {t('toolProfile')}
            <select
              className={INPUT}
              data-testid={`provider-model-tools-${model.id}`}
              value={model.tool_profile ?? ''}
              onChange={event =>
                onChange({
                  tool_profile: (event.target.value as ProviderModel['tool_profile']) || undefined,
                })
              }
            >
              <option value="">{t('automatic')}</option>
              {(format === 'openai-responses'
                ? ['custom', 'function', 'shell']
                : ['function', 'shell']
              ).map(value => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          {format === 'openai-responses' && (
            <label className="space-y-1 text-sm text-text-secondary">
              {t('toolCompatibility')}
              <select
                className={INPUT}
                data-testid={`provider-model-compatibility-${model.id}`}
                value={model.codex_tool_compatibility ?? 'native'}
                onChange={event =>
                  onChange({
                    codex_tool_compatibility: event.target
                      .value as ProviderModel['codex_tool_compatibility'],
                  })
                }
              >
                <option value="native">native</option>
                <option value="standard">standard</option>
              </select>
            </label>
          )}
        </div>
      </details>
    </div>
  )
}
