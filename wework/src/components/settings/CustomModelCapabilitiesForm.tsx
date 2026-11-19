import {
  CollapsibleRoot,
  CollapsibleTrigger,
  CollapsiblePanel,
} from '@wegent/collaboration/controls/Collapsible'
import { DeleteIconButton } from '@wegent/collaboration/controls/DeleteIconButton'
import type { LocalModelCatalogEntry } from '@/features/model-settings/localModelCatalog'
import type {
  LocalModelApiFormat,
  LocalModelCodexToolCompatibility,
} from '@/features/model-settings/localModelSettings'
import { useTranslation } from '@/hooks/useTranslation'
import { Checkbox } from '@wegent/collaboration/controls/Checkbox'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import {
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
} from '@wegent/collaboration/controls/SelectParts'
import { normalizeSelectValue } from '@wegent/collaboration/controls/selectValue'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { Textarea as ControlTextarea } from '@wegent/collaboration/controls/Textarea'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Plus, X } from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'

type CatalogObject = Record<string, unknown>

const REASONING_LEVEL_OPTIONS = [
  { effort: 'none', labelKey: 'none', description: 'No reasoning' },
  { effort: 'minimal', labelKey: 'minimal', description: 'Minimal reasoning' },
  { effort: 'low', labelKey: 'low', description: 'Light reasoning' },
  { effort: 'medium', labelKey: 'medium', description: 'Balanced reasoning' },
  { effort: 'high', labelKey: 'high', description: 'Deep reasoning' },
  { effort: 'xhigh', labelKey: 'xhigh', description: 'Extra-high reasoning' },
  { effort: 'max', labelKey: 'max', description: 'Maximum reasoning' },
  { effort: 'ultra', labelKey: 'ultra', description: 'Ultra reasoning' },
] as const

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function nullableString(value: string): string | null {
  const trimmed = value.trim()
  return trimmed || null
}

function numberValue(value: unknown, fallback = ''): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : fallback
}

function nullableNumber(value: string): number | null {
  if (!value.trim()) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function structuredItems(value: unknown): CatalogObject[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is CatalogObject =>
          Boolean(item) && typeof item === 'object' && !Array.isArray(item)
      )
    : []
}

function nestedObject(value: unknown): CatalogObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as CatalogObject) : {}
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <fieldset className="grid min-w-0 content-start gap-1.5 text-xs font-medium text-text-secondary">
      <legend className="mb-1.5">{label}</legend>
      {children}
      {hint && <span className="text-xs font-normal leading-5 text-text-muted">{hint}</span>}
    </fieldset>
  )
}

function BooleanSelect({
  testId,
  value,
  onChange,
}: {
  testId: string
  value: boolean
  onChange: (value: boolean) => void
}) {
  const { t } = useTranslation('common')
  return (
    <label className="flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-normal text-text-secondary">
      <Checkbox
        data-testid={testId}
        checked={value}
        onCheckedChange={checked => onChange(checked === true)}
        className="h-4 w-4 rounded border-border text-primary"
      />
      {t('workbench.local_model_codex_feature_enabled')}
    </label>
  )
}

function TagListEditor({
  testId,
  value,
  placeholder,
  onChange,
}: {
  testId: string
  value: unknown
  placeholder?: string
  onChange: (value: string[]) => void
}) {
  const { t } = useTranslation('common')
  const [draft, setDraft] = useState('')
  const values = Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
  const addDraft = () => {
    const next = draft.trim()
    if (!next || values.includes(next)) return
    onChange([...values, next])
    setDraft('')
  }
  return (
    <div data-testid={testId} className="grid gap-2">
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {values.map(item => (
            <span
              key={item}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-muted px-2 text-xs text-text-secondary"
            >
              {item}
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid={`${testId}-remove-${item}`}
                aria-label={t('common.delete', '删除')}
                onClick={() => onChange(values.filter(value => value !== item))}
                className="text-text-muted hover:text-text-primary"
              >
                <X className="h-3 w-3" />
              </ControlButton>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <ControlInput
          data-testid={`${testId}-input`}
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              addDraft()
            }
          }}
          placeholder={placeholder}
          className="w-full"
        />
        <ControlButton
          variant="outline"
          size="sm"
          type="button"
          data-testid={`${testId}-add`}
          onClick={addDraft}
          disabled={!draft.trim()}
          className="inline-flex h-9 shrink-0 items-center gap-1 rounded-md border border-border bg-background px-3 text-sm text-text-secondary hover:bg-muted disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('common.add', '添加')}
        </ControlButton>
      </div>
    </div>
  )
}

function StructuredListEditor({
  testId,
  value,
  fields,
  addLabel,
  onChange,
}: {
  testId: string
  value: unknown
  fields: Array<{ key: string; label: string; placeholder?: string }>
  addLabel: string
  onChange: (value: CatalogObject[]) => void
}) {
  const { t } = useTranslation('common')
  const items = structuredItems(value)
  return (
    <div data-testid={testId} className="grid gap-2">
      {items.map((item, index) => (
        <div
          key={index}
          className={`grid gap-2 rounded-md border border-border bg-background p-2 ${
            fields.length === 3
              ? 'sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,2fr)_2rem]'
              : 'sm:grid-cols-[minmax(0,0.7fr)_minmax(0,2fr)_2rem]'
          }`}
        >
          {fields.map(field => (
            <label key={field.key} className="grid gap-1 text-xs font-normal text-text-muted">
              {field.label}
              <ControlInput
                data-testid={`${testId}-${index}-${field.key}`}
                value={stringValue(item[field.key])}
                onChange={event => {
                  const next = [...items]
                  next[index] = { ...item, [field.key]: event.target.value }
                  onChange(next)
                }}
                placeholder={field.placeholder}
                className="w-full"
              />
            </label>
          ))}
          <span className="mt-5 self-start">
            <DeleteIconButton
              type="button"
              data-testid={`${testId}-${index}-delete`}
              aria-label={t('common.delete', '删除')}
              onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}
            />
          </span>
        </div>
      ))}
      <ControlButton
        variant="outline"
        size="sm"
        type="button"
        data-testid={`${testId}-add`}
        onClick={() =>
          onChange([...items, Object.fromEntries(fields.map(field => [field.key, '']))])
        }
        className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm text-text-secondary hover:bg-muted hover:text-text-primary"
      >
        <Plus className="h-3.5 w-3.5" />
        {addLabel}
      </ControlButton>
    </div>
  )
}

export function CustomModelCapabilitiesForm({
  entry,
  contextWindow,
  maxOutputTokens,
  apiFormat,
  codexToolCompatibility,
  onContextWindowChange,
  onMaxOutputTokensChange,
  onCodexToolCompatibilityChange,
  onChange,
}: {
  entry: LocalModelCatalogEntry
  contextWindow: string
  maxOutputTokens?: string
  apiFormat?: LocalModelApiFormat
  codexToolCompatibility?: LocalModelCodexToolCompatibility
  onContextWindowChange: (value: string) => void
  onMaxOutputTokensChange?: (value: string) => void
  onCodexToolCompatibilityChange?: (value: LocalModelCodexToolCompatibility) => void
  onChange: (entry: LocalModelCatalogEntry) => void
}) {
  const { t } = useTranslation('common')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [advancedSection, setAdvancedSection] = useState<'capabilities' | 'metadata' | 'prompts'>(
    'capabilities'
  )
  const update = (patch: CatalogObject) => onChange({ ...entry, ...patch })
  const modelMessages = {
    instructions_template: null,
    instructions_variables: null,
    approvals: null,
    auto_review: null,
    permissions: null,
    ...nestedObject(entry.model_messages),
  }
  const instructionVariables = {
    personality_default: null,
    personality_friendly: null,
    personality_pragmatic: null,
    ...nestedObject(modelMessages.instructions_variables),
  }
  const approvals = {
    on_request: null,
    on_request_auto_review: null,
    ...nestedObject(modelMessages.approvals),
  }
  const autoReview = {
    policy: null,
    policy_template: null,
    ...nestedObject(modelMessages.auto_review),
  }
  const permissions = {
    danger_full_access: null,
    workspace_write: null,
    read_only: null,
    ...nestedObject(modelMessages.permissions),
  }
  const upgrade = {
    model: '',
    migration_markdown: '',
    ...nestedObject(entry.upgrade),
  }
  const updateModelMessages = (patch: CatalogObject) =>
    update({ model_messages: { ...modelMessages, ...patch } })
  const updateMessageGroup = (key: string, current: CatalogObject, patch: CatalogObject) =>
    updateModelMessages({ [key]: { ...current, ...patch } })

  return (
    <section
      data-testid="local-model-capabilities-form"
      className="grid gap-4 border-t border-border pt-4"
    >
      <div>
        <h3 className="text-sm font-semibold text-text-primary">
          {t('workbench.local_model_capabilities_title', '模型能力')}
        </h3>
        <p className="mt-1 text-xs leading-5 text-text-muted">
          {t(
            'workbench.local_model_capabilities_hint',
            '这些设置决定 Codex 如何使用模型。常用能力直接配置，高级元数据可按需展开。'
          )}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label={t('workbench.local_model_context_window_label', '最大上下文')}
          hint={t(
            'workbench.local_model_context_window_hint',
            '用于上下文计算和自动压缩；Catalog 与运行时共用此值。'
          )}
        >
          <ControlInput
            data-testid="local-model-context-window-input"
            value={contextWindow}
            onChange={event => onContextWindowChange(event.target.value)}
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            placeholder="272000"
            className="w-full"
          />
        </Field>
        {onMaxOutputTokensChange && (
          <Field
            label={t('workbench.local_model_max_output_tokens_label')}
            hint={t('workbench.local_model_max_output_tokens_hint')}
          >
            <ControlInput
              data-testid="local-model-max-output-tokens-input"
              value={maxOutputTokens ?? ''}
              onChange={event => onMaxOutputTokensChange(event.target.value)}
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              className="w-full"
            />
          </Field>
        )}
        <Field label={t('workbench.local_model_description_label', '模型说明')}>
          <ControlInput
            data-testid="local-model-catalog-description-input"
            value={stringValue(entry.description)}
            onChange={event => update({ description: event.target.value })}
            className="w-full"
          />
        </Field>
        <Field label={t('workbench.local_model_reasoning_levels_label', '支持的推理等级')}>
          <div
            data-testid="local-model-reasoning-levels"
            className="grid grid-cols-2 gap-2 rounded-md border border-border bg-background p-3 sm:grid-cols-4"
          >
            {REASONING_LEVEL_OPTIONS.map(option => {
              const current = structuredItems(entry.supported_reasoning_levels)
              const checked = current.some(item => item.effort === option.effort)
              return (
                <label
                  key={option.effort}
                  className="inline-flex h-8 items-center gap-2 text-sm font-normal text-text-secondary"
                >
                  <Checkbox
                    data-testid={`local-model-reasoning-level-${option.effort}`}
                    checked={checked}
                    onCheckedChange={checked => {
                      const next =
                        checked === true
                          ? [...current, { effort: option.effort, description: option.description }]
                          : current.filter(item => item.effort !== option.effort)
                      const knownEfforts = new Set<string>(
                        REASONING_LEVEL_OPTIONS.map(candidate => candidate.effort)
                      )
                      update({
                        supported_reasoning_levels: [
                          ...REASONING_LEVEL_OPTIONS.flatMap(candidate =>
                            next.filter(item => item.effort === candidate.effort)
                          ),
                          ...next.filter(item => !knownEfforts.has(stringValue(item.effort))),
                        ],
                        ...(!(checked === true) && entry.default_reasoning_level === option.effort
                          ? { default_reasoning_level: null }
                          : {}),
                      })
                    }}
                    className="h-4 w-4 rounded border-border text-primary"
                  />
                  {t(`workbench.local_model_reasoning_${option.labelKey}`)}
                </label>
              )
            })}
          </div>
        </Field>
        <Field label={t('workbench.local_model_default_reasoning_label', '默认推理等级')}>
          <SelectRoot
            value={normalizeSelectValue(stringValue(entry.default_reasoning_level))}
            onValueChange={selectedValue => {
              if (selectedValue !== null)
                return update({ default_reasoning_level: nullableString(selectedValue) })
            }}
          >
            <SelectTrigger
              aria-label={t('workbench.local_model_default_reasoning_label', '默认推理等级')}
              data-testid="local-model-default-reasoning-input"
              className="w-full"
            />
            <SelectContent>
              <SelectItem value="">
                {t('workbench.local_model_automatic_option', '自动')}
              </SelectItem>
              {structuredItems(entry.supported_reasoning_levels).map(item => {
                const effort = stringValue(item.effort)
                const knownOption = REASONING_LEVEL_OPTIONS.find(option => option.effort === effort)
                return effort ? (
                  <SelectItem key={effort} value={String(effort)}>
                    {knownOption
                      ? t(`workbench.local_model_reasoning_${knownOption.labelKey}`)
                      : effort}
                  </SelectItem>
                ) : null
              })}
            </SelectContent>
          </SelectRoot>
        </Field>
        <Field label={t('workbench.local_model_parallel_tools_label', '并行工具调用')}>
          <BooleanSelect
            testId="local-model-parallel-tools-select"
            value={entry.supports_parallel_tool_calls === true}
            onChange={value => update({ supports_parallel_tool_calls: value })}
          />
        </Field>
        <Field label={t('workbench.local_model_input_modalities_label', '输入类型')}>
          <div className="flex h-9 items-center gap-5 rounded-md border border-border bg-background px-3">
            {(
              [
                ['text', t('workbench.local_model_input_modality_text', '文本')],
                ['image', t('workbench.local_model_input_modality_image', '图片')],
              ] as const
            ).map(([modality, label]) => {
              const modalities = Array.isArray(entry.input_modalities)
                ? entry.input_modalities.filter(value => typeof value === 'string')
                : []
              return (
                <label
                  key={modality}
                  className="inline-flex items-center gap-2 text-sm font-normal text-text-secondary"
                >
                  <Checkbox
                    data-testid={`local-model-input-modality-${modality}`}
                    checked={modalities.includes(modality)}
                    onCheckedChange={checked =>
                      update({
                        input_modalities:
                          checked === true
                            ? [...modalities, modality]
                            : modalities.filter(value => value !== modality),
                      })
                    }
                    className="h-4 w-4 rounded border-border text-primary"
                  />
                  {label}
                </label>
              )
            })}
          </div>
        </Field>
      </div>

      <CollapsibleRoot className="rounded-md border border-border bg-surface px-3 py-2">
        <CollapsibleTrigger
          data-testid="local-model-base-instructions-toggle"
          className="cursor-pointer text-sm font-medium text-text-secondary"
        >
          {t('workbench.local_model_base_instructions_label', '基础提示词')}
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="mt-3">
            <Field
              label={t('workbench.local_model_base_instructions_label', '基础提示词')}
              hint={t(
                'workbench.local_model_base_instructions_hint',
                '完整的模型基础行为提示词。默认参考当前 GPT/Codex profile，可直接编辑。'
              )}
            >
              <ControlTextarea
                data-testid="local-model-base-instructions-input"
                value={stringValue(entry.base_instructions)}
                onChange={event => update({ base_instructions: event.target.value })}
                spellCheck={false}
                className="w-full resize-y min-h-64"
              />
            </Field>
          </div>
        </CollapsiblePanel>
      </CollapsibleRoot>

      <ControlButton
        variant="outline"
        size="sm"
        type="button"
        onClick={() => setAdvancedOpen(true)}
        className="flex h-9 items-center rounded-md border border-border bg-surface px-3 text-sm font-medium text-text-secondary hover:bg-muted hover:text-text-primary"
      >
        <span data-testid="local-model-advanced-capabilities-toggle">
          {t('workbench.local_model_advanced_capabilities_title', '高级模型能力')}
        </span>
      </ControlButton>
      {advancedOpen &&
        createPortal(
          <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 p-6">
            <DialogSurface
              onClose={() => setAdvancedOpen(false)}
              render={
                <div
                  aria-labelledby="local-model-advanced-dialog-title"
                  data-testid="local-model-advanced-capabilities-dialog"
                  className="flex max-h-[min(760px,calc(100vh-3rem))] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-[0_18px_50px_rgba(0,0,0,0.28)]"
                />
              }
            >
              <header className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
                <div>
                  <h2
                    id="local-model-advanced-dialog-title"
                    className="text-sm font-semibold text-text-primary"
                  >
                    {t('workbench.local_model_advanced_capabilities_title', '高级模型能力')}
                  </h2>
                  <p className="mt-1 text-xs text-text-muted">
                    {t(
                      'workbench.local_model_advanced_dialog_hint',
                      '按类别配置不常用的 Codex Catalog 能力。'
                    )}
                  </p>
                </div>
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="local-model-advanced-capabilities-close"
                  aria-label={t('common.close', '关闭')}
                  onClick={() => setAdvancedOpen(false)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text-primary"
                >
                  <X className="h-4 w-4" />
                </ControlButton>
              </header>
              <div className="grid min-h-0 flex-1 grid-cols-[11rem_minmax(0,1fr)]">
                <nav className="grid content-start gap-1 border-r border-border bg-surface p-3">
                  {(
                    [
                      [
                        'capabilities',
                        t('workbench.local_model_advanced_section_capabilities', '响应与工具'),
                      ],
                      [
                        'metadata',
                        t('workbench.local_model_advanced_section_metadata', 'Catalog 元数据'),
                      ],
                      [
                        'prompts',
                        t('workbench.local_model_advanced_section_prompts', '提示词模板'),
                      ],
                    ] as const
                  ).map(([section, label]) => (
                    <ControlButton
                      variant="unstyled"
                      key={section}
                      type="button"
                      data-testid={`local-model-advanced-section-${section}`}
                      onClick={() => setAdvancedSection(section)}
                      className={`h-8 rounded-md px-2.5 text-left text-sm ${
                        advancedSection === section
                          ? 'bg-muted font-medium text-text-primary'
                          : 'text-text-secondary hover:bg-muted/70 hover:text-text-primary'
                      }`}
                    >
                      {label}
                    </ControlButton>
                  ))}
                </nav>
                <div className="min-h-0 overflow-y-auto p-5">
                  <div className="grid gap-4">
                    {advancedSection === 'capabilities' && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        {apiFormat === 'openai-responses' &&
                          codexToolCompatibility &&
                          onCodexToolCompatibilityChange && (
                            <Field
                              label={t(
                                'workbench.local_model_codex_tool_compatibility_label',
                                'Codex 工具协议兼容性'
                              )}
                              hint={t(
                                'workbench.local_model_codex_tool_compatibility_hint',
                                '完整兼容 Codex 工具协议时直接透传；仅支持标准 Responses function calling 时由 Wework 转换。'
                              )}
                            >
                              <SelectRoot
                                value={normalizeSelectValue(codexToolCompatibility)}
                                onValueChange={selectedValue => {
                                  if (selectedValue !== null)
                                    return onCodexToolCompatibilityChange(
                                      selectedValue as LocalModelCodexToolCompatibility
                                    )
                                }}
                              >
                                <SelectTrigger
                                  aria-label={t(
                                    'workbench.local_model_codex_tool_compatibility_label',
                                    'Codex 工具协议兼容性'
                                  )}
                                  data-testid="local-model-codex-tool-compatibility-select"
                                  className="w-full"
                                />
                                <SelectContent>
                                  <SelectItem value="native">
                                    {t(
                                      'workbench.local_model_codex_tool_compatibility_native',
                                      '原生兼容'
                                    )}
                                  </SelectItem>
                                  <SelectItem value="standard">
                                    {t(
                                      'workbench.local_model_codex_tool_compatibility_standard',
                                      '仅兼容标准 Responses（推荐）'
                                    )}
                                  </SelectItem>
                                </SelectContent>
                              </SelectRoot>
                            </Field>
                          )}
                        <Field
                          label={t('workbench.local_model_field_reasoning_summary', '推理摘要参数')}
                        >
                          <BooleanSelect
                            testId="local-model-reasoning-summary-support-select"
                            value={entry.supports_reasoning_summary_parameter === true}
                            onChange={value =>
                              update({ supports_reasoning_summary_parameter: value })
                            }
                          />
                        </Field>
                        <Field
                          label={t(
                            'workbench.local_model_field_default_reasoning_summary',
                            '默认推理摘要'
                          )}
                        >
                          <SelectRoot
                            value={normalizeSelectValue(
                              stringValue(entry.default_reasoning_summary) || 'auto'
                            )}
                            onValueChange={selectedValue => {
                              if (selectedValue !== null)
                                return update({ default_reasoning_summary: selectedValue })
                            }}
                          >
                            <SelectTrigger
                              aria-label={t(
                                'workbench.local_model_field_default_reasoning_summary',
                                '默认推理摘要'
                              )}
                              data-testid="local-model-default-reasoning-summary-select"
                              className="w-full"
                            />
                            <SelectContent>
                              {['auto', 'concise', 'detailed', 'none'].map(value => (
                                <SelectItem key={value} value={String(value)}>
                                  {value}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </SelectRoot>
                        </Field>
                        <Field label={t('workbench.local_model_field_verbosity', '详细程度参数')}>
                          <BooleanSelect
                            testId="local-model-verbosity-support-select"
                            value={entry.support_verbosity === true}
                            onChange={value => update({ support_verbosity: value })}
                          />
                        </Field>
                        <Field
                          label={t('workbench.local_model_field_default_verbosity', '默认详细程度')}
                        >
                          <SelectRoot
                            value={normalizeSelectValue(stringValue(entry.default_verbosity))}
                            onValueChange={selectedValue => {
                              if (selectedValue !== null)
                                return update({ default_verbosity: nullableString(selectedValue) })
                            }}
                          >
                            <SelectTrigger
                              aria-label={t(
                                'workbench.local_model_field_default_verbosity',
                                '默认详细程度'
                              )}
                              data-testid="local-model-default-verbosity-select"
                              className="w-full"
                            />
                            <SelectContent>
                              <SelectItem value="">Auto</SelectItem>
                              {['low', 'medium', 'high'].map(value => (
                                <SelectItem key={value} value={String(value)}>
                                  {value}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </SelectRoot>
                        </Field>
                        <Field
                          label={t('workbench.local_model_field_original_image', '原始图片精度')}
                        >
                          <BooleanSelect
                            testId="local-model-image-detail-original-select"
                            value={entry.supports_image_detail_original === true}
                            onChange={value => update({ supports_image_detail_original: value })}
                          />
                        </Field>
                        <Field
                          label={t(
                            'workbench.local_model_field_skill_instructions',
                            '包含技能使用说明'
                          )}
                        >
                          <BooleanSelect
                            testId="local-model-skills-instructions-select"
                            value={entry.include_skills_usage_instructions === true}
                            onChange={value => update({ include_skills_usage_instructions: value })}
                          />
                        </Field>
                        <Field
                          label={t('workbench.local_model_field_shell_type', 'Shell 工具类型')}
                        >
                          <SelectRoot
                            value={normalizeSelectValue(stringValue(entry.shell_type))}
                            onValueChange={selectedValue => {
                              if (selectedValue !== null)
                                return update({ shell_type: selectedValue })
                            }}
                          >
                            <SelectTrigger
                              aria-label={t(
                                'workbench.local_model_field_shell_type',
                                'Shell 工具类型'
                              )}
                              data-testid="local-model-shell-type-select"
                              className="w-full"
                            />
                            <SelectContent>
                              {[
                                'default',
                                'local',
                                'unified_exec',
                                'disabled',
                                'shell_command',
                              ].map(value => (
                                <SelectItem key={value} value={String(value)}>
                                  {value}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </SelectRoot>
                        </Field>
                        <Field label={t('workbench.local_model_field_apply_patch', '补丁工具')}>
                          <SelectRoot
                            value={normalizeSelectValue(stringValue(entry.apply_patch_tool_type))}
                            onValueChange={selectedValue => {
                              if (selectedValue !== null)
                                return update({
                                  apply_patch_tool_type: nullableString(selectedValue),
                                })
                            }}
                          >
                            <SelectTrigger
                              aria-label={t('workbench.local_model_field_apply_patch', '补丁工具')}
                              data-testid="local-model-apply-patch-type-select"
                              className="w-full"
                            />
                            <SelectContent>
                              <SelectItem value="">Disabled</SelectItem>
                              <SelectItem value="freeform">freeform</SelectItem>
                            </SelectContent>
                          </SelectRoot>
                        </Field>
                        <Field
                          label={t(
                            'workbench.local_model_field_web_search_type',
                            '网页搜索工具类型'
                          )}
                        >
                          <SelectRoot
                            value={normalizeSelectValue(
                              stringValue(entry.web_search_tool_type) || 'text'
                            )}
                            onValueChange={selectedValue => {
                              if (selectedValue !== null)
                                return update({ web_search_tool_type: selectedValue })
                            }}
                          >
                            <SelectTrigger
                              aria-label={t(
                                'workbench.local_model_field_web_search_type',
                                '网页搜索工具类型'
                              )}
                              data-testid="local-model-web-search-tool-type-select"
                              className="w-full"
                            />
                            <SelectContent>
                              <SelectItem value="text">text</SelectItem>
                              <SelectItem value="text_and_image">text_and_image</SelectItem>
                            </SelectContent>
                          </SelectRoot>
                        </Field>
                        <Field
                          label={t('workbench.local_model_field_search_tool', '按需工具搜索')}
                          hint={t(
                            'workbench.local_model_field_search_tool_hint',
                            '允许 Codex 先搜索再加载 MCP 工具，减少首次请求的工具数量。'
                          )}
                        >
                          <BooleanSelect
                            testId="local-model-search-tool-select"
                            value={entry.supports_search_tool === true}
                            onChange={value => update({ supports_search_tool: value })}
                          />
                        </Field>
                        <Field
                          label={t('workbench.local_model_field_responses_lite', 'Responses Lite')}
                        >
                          <BooleanSelect
                            testId="local-model-responses-lite-select"
                            value={entry.use_responses_lite === true}
                            onChange={value => update({ use_responses_lite: value })}
                          />
                        </Field>
                        <Field label={t('workbench.local_model_field_tool_mode', '工具模式')}>
                          <SelectRoot
                            value={normalizeSelectValue(stringValue(entry.tool_mode))}
                            onValueChange={selectedValue => {
                              if (selectedValue !== null)
                                return update({ tool_mode: nullableString(selectedValue) })
                            }}
                          >
                            <SelectTrigger
                              aria-label={t('workbench.local_model_field_tool_mode', '工具模式')}
                              data-testid="local-model-tool-mode-select"
                              className="w-full"
                            />
                            <SelectContent>
                              <SelectItem value="">Default</SelectItem>
                              {['direct', 'code_mode', 'code_mode_only'].map(value => (
                                <SelectItem key={value} value={String(value)}>
                                  {value}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </SelectRoot>
                        </Field>
                        <Field label={t('workbench.local_model_field_multi_agent', '多智能体版本')}>
                          <SelectRoot
                            value={normalizeSelectValue(stringValue(entry.multi_agent_version))}
                            onValueChange={selectedValue => {
                              if (selectedValue !== null)
                                return update({
                                  multi_agent_version: nullableString(selectedValue),
                                })
                            }}
                          >
                            <SelectTrigger
                              aria-label={t(
                                'workbench.local_model_field_multi_agent',
                                '多智能体版本'
                              )}
                              data-testid="local-model-multi-agent-version-select"
                              className="w-full"
                            />
                            <SelectContent>
                              <SelectItem value="">Default</SelectItem>
                              {['disabled', 'v1', 'v2'].map(value => (
                                <SelectItem key={value} value={String(value)}>
                                  {value}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </SelectRoot>
                        </Field>
                        <Field
                          label={t('workbench.local_model_field_experimental_tools', '实验性工具')}
                        >
                          <TagListEditor
                            testId="local-model-experimental-tools"
                            value={entry.experimental_supported_tools}
                            placeholder={t(
                              'workbench.local_model_tag_placeholder',
                              '输入名称后添加'
                            )}
                            onChange={value => update({ experimental_supported_tools: value })}
                          />
                        </Field>
                      </div>
                    )}

                    {advancedSection === 'metadata' && (
                      <div className="grid gap-4">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <Field label={t('workbench.local_model_field_visibility', '可见性')}>
                            <SelectRoot
                              value={normalizeSelectValue(stringValue(entry.visibility))}
                              onValueChange={selectedValue => {
                                if (selectedValue !== null)
                                  return update({ visibility: selectedValue })
                              }}
                            >
                              <SelectTrigger
                                aria-label={t('workbench.local_model_field_visibility', '可见性')}
                                data-testid="local-model-visibility-select"
                                className="w-full"
                              />
                              <SelectContent>
                                {['list', 'hide', 'none'].map(value => (
                                  <SelectItem key={value} value={String(value)}>
                                    {value}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </SelectRoot>
                          </Field>
                          <Field label={t('workbench.local_model_field_supported_api', 'API 可用')}>
                            <BooleanSelect
                              testId="local-model-supported-api-select"
                              value={entry.supported_in_api === true}
                              onChange={value => update({ supported_in_api: value })}
                            />
                          </Field>
                          <Field label={t('workbench.local_model_field_priority', '优先级')}>
                            <ControlInput
                              data-testid="local-model-priority-input"
                              type="number"
                              value={numberValue(entry.priority, '10000')}
                              onChange={event =>
                                update({ priority: nullableNumber(event.target.value) })
                              }
                              className="w-full"
                            />
                          </Field>
                          <Field
                            label={t(
                              'workbench.local_model_field_effective_context',
                              '有效上下文比例'
                            )}
                          >
                            <ControlInput
                              data-testid="local-model-effective-context-input"
                              type="number"
                              min={1}
                              max={100}
                              value={numberValue(entry.effective_context_window_percent, '95')}
                              onChange={event =>
                                update({
                                  effective_context_window_percent: nullableNumber(
                                    event.target.value
                                  ),
                                })
                              }
                              className="w-full"
                            />
                          </Field>
                          <Field
                            label={t('workbench.local_model_field_auto_compact', '自动压缩阈值')}
                          >
                            <ControlInput
                              data-testid="local-model-auto-compact-input"
                              type="number"
                              value={numberValue(entry.auto_compact_token_limit)}
                              onChange={event =>
                                update({
                                  auto_compact_token_limit: nullableNumber(event.target.value),
                                })
                              }
                              className="w-full"
                            />
                          </Field>
                          <Field label={t('workbench.local_model_field_comp_hash', '压缩兼容标识')}>
                            <ControlInput
                              data-testid="local-model-comp-hash-input"
                              value={stringValue(entry.comp_hash)}
                              onChange={event =>
                                update({ comp_hash: nullableString(event.target.value) })
                              }
                              className="w-full"
                            />
                          </Field>
                          <Field
                            label={t('workbench.local_model_field_truncation_mode', '截断模式')}
                          >
                            <SelectRoot
                              value={normalizeSelectValue(
                                stringValue(nestedObject(entry.truncation_policy).mode) || 'tokens'
                              )}
                              onValueChange={selectedValue => {
                                if (selectedValue !== null)
                                  return update({
                                    truncation_policy: {
                                      ...nestedObject(entry.truncation_policy),
                                      mode: selectedValue,
                                    },
                                  })
                              }}
                            >
                              <SelectTrigger
                                aria-label={t(
                                  'workbench.local_model_field_truncation_mode',
                                  '截断模式'
                                )}
                                data-testid="local-model-truncation-mode-select"
                                className="w-full"
                              />
                              <SelectContent>
                                <SelectItem value="tokens">tokens</SelectItem>
                                <SelectItem value="bytes">bytes</SelectItem>
                              </SelectContent>
                            </SelectRoot>
                          </Field>
                          <Field
                            label={t('workbench.local_model_field_truncation_limit', '截断保留量')}
                          >
                            <ControlInput
                              data-testid="local-model-truncation-limit-input"
                              type="number"
                              min={1}
                              value={numberValue(
                                nestedObject(entry.truncation_policy).limit,
                                '10000'
                              )}
                              onChange={event =>
                                update({
                                  truncation_policy: {
                                    ...nestedObject(entry.truncation_policy),
                                    limit: nullableNumber(event.target.value),
                                  },
                                })
                              }
                              className="w-full"
                            />
                          </Field>
                          <Field
                            label={t('workbench.local_model_field_speed_tiers', '附加速度档位')}
                          >
                            <TagListEditor
                              testId="local-model-speed-tiers"
                              value={entry.additional_speed_tiers}
                              placeholder={t(
                                'workbench.local_model_tag_placeholder',
                                '输入名称后添加'
                              )}
                              onChange={value => update({ additional_speed_tiers: value })}
                            />
                          </Field>
                          <Field
                            label={t(
                              'workbench.local_model_field_default_service_tier',
                              '默认服务档位'
                            )}
                          >
                            <SelectRoot
                              value={normalizeSelectValue(stringValue(entry.default_service_tier))}
                              onValueChange={selectedValue => {
                                if (selectedValue !== null)
                                  return update({
                                    default_service_tier: nullableString(selectedValue),
                                  })
                              }}
                            >
                              <SelectTrigger
                                aria-label={t(
                                  'workbench.local_model_field_default_service_tier',
                                  '默认服务档位'
                                )}
                                data-testid="local-model-default-service-tier-input"
                                className="w-full"
                              />
                              <SelectContent>
                                <SelectItem value="">
                                  {t('workbench.local_model_automatic_option', '自动')}
                                </SelectItem>
                                {structuredItems(entry.service_tiers).map(item => {
                                  const id = stringValue(item.id)
                                  return id ? (
                                    <SelectItem key={id} value={String(id)}>
                                      {stringValue(item.name) || id}
                                    </SelectItem>
                                  ) : null
                                })}
                              </SelectContent>
                            </SelectRoot>
                          </Field>
                        </div>

                        <Field label={t('workbench.local_model_field_service_tiers', '服务档位')}>
                          <StructuredListEditor
                            testId="local-model-service-tiers"
                            value={entry.service_tiers}
                            fields={[
                              { key: 'id', label: 'ID' },
                              { key: 'name', label: t('workbench.local_model_name_label', '名称') },
                              {
                                key: 'description',
                                label: t('workbench.local_model_description_label', '说明'),
                              },
                            ]}
                            addLabel={t('workbench.local_model_add_service_tier', '添加服务档位')}
                            onChange={value => update({ service_tiers: value })}
                          />
                        </Field>

                        <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
                          <Field
                            label={t(
                              'workbench.local_model_field_availability_message',
                              '可用性提示'
                            )}
                          >
                            <ControlInput
                              data-testid="local-model-availability-message-input"
                              value={stringValue(nestedObject(entry.availability_nux).message)}
                              onChange={event =>
                                update({
                                  availability_nux: event.target.value
                                    ? { message: event.target.value }
                                    : null,
                                })
                              }
                              className="w-full"
                            />
                          </Field>
                          <Field
                            label={t('workbench.local_model_field_upgrade_model', '升级目标模型')}
                          >
                            <ControlInput
                              data-testid="local-model-upgrade-model-input"
                              value={stringValue(nestedObject(entry.upgrade).model)}
                              onChange={event =>
                                update({
                                  upgrade: event.target.value
                                    ? {
                                        ...upgrade,
                                        model: event.target.value,
                                      }
                                    : null,
                                })
                              }
                              className="w-full"
                            />
                          </Field>
                          <Field
                            label={t(
                              'workbench.local_model_field_upgrade_markdown',
                              '升级迁移说明'
                            )}
                          >
                            <ControlTextarea
                              data-testid="local-model-upgrade-markdown-input"
                              value={stringValue(nestedObject(entry.upgrade).migration_markdown)}
                              onChange={event =>
                                update({
                                  upgrade: {
                                    ...upgrade,
                                    migration_markdown: event.target.value,
                                  },
                                })
                              }
                              className="w-full resize-y min-h-24"
                            />
                          </Field>
                          <Field
                            label={t(
                              'workbench.local_model_field_auto_review_model',
                              '自动审查模型覆盖'
                            )}
                          >
                            <ControlInput
                              data-testid="local-model-auto-review-override-input"
                              value={stringValue(entry.auto_review_model_override)}
                              onChange={event =>
                                update({
                                  auto_review_model_override: nullableString(event.target.value),
                                })
                              }
                              className="w-full"
                            />
                          </Field>
                        </div>
                      </div>
                    )}

                    {advancedSection === 'prompts' && (
                      <div className="grid gap-3">
                        <Field
                          label={t('workbench.local_model_field_instructions_template', '指令模板')}
                        >
                          <ControlTextarea
                            data-testid="local-model-instructions-template-input"
                            value={stringValue(modelMessages.instructions_template)}
                            onChange={event =>
                              updateModelMessages({
                                instructions_template: nullableString(event.target.value),
                              })
                            }
                            className="w-full resize-y min-h-32"
                          />
                        </Field>
                        <div className="grid gap-3 sm:grid-cols-2">
                          {(
                            [
                              [
                                'personality_default',
                                t('workbench.local_model_personality_default', '默认个性提示词'),
                              ],
                              [
                                'personality_friendly',
                                t('workbench.local_model_personality_friendly', '友好个性提示词'),
                              ],
                              [
                                'personality_pragmatic',
                                t('workbench.local_model_personality_pragmatic', '务实个性提示词'),
                              ],
                            ] as const
                          ).map(([key, label]) => (
                            <Field key={key} label={label}>
                              <ControlTextarea
                                data-testid={`local-model-${key}-input`}
                                value={stringValue(instructionVariables[key])}
                                onChange={event =>
                                  updateMessageGroup(
                                    'instructions_variables',
                                    instructionVariables,
                                    {
                                      [key]: nullableString(event.target.value),
                                    }
                                  )
                                }
                                className="w-full resize-y min-h-24"
                              />
                            </Field>
                          ))}
                          {[
                            [
                              'on_request',
                              t('workbench.local_model_message_approval_request', '按需审批消息'),
                              approvals,
                              'approvals',
                            ],
                            [
                              'on_request_auto_review',
                              t(
                                'workbench.local_model_message_approval_review',
                                '自动审查审批消息'
                              ),
                              approvals,
                              'approvals',
                            ],
                            [
                              'policy',
                              t('workbench.local_model_message_review_policy', '自动审查策略'),
                              autoReview,
                              'auto_review',
                            ],
                            [
                              'policy_template',
                              t(
                                'workbench.local_model_message_review_template',
                                '自动审查策略模板'
                              ),
                              autoReview,
                              'auto_review',
                            ],
                            [
                              'danger_full_access',
                              t('workbench.local_model_message_full_access', '完全访问权限消息'),
                              permissions,
                              'permissions',
                            ],
                            [
                              'workspace_write',
                              t(
                                'workbench.local_model_message_workspace_write',
                                '工作区写入权限消息'
                              ),
                              permissions,
                              'permissions',
                            ],
                            [
                              'read_only',
                              t('workbench.local_model_message_read_only', '只读权限消息'),
                              permissions,
                              'permissions',
                            ],
                          ].map(([key, label, group, groupKey]) => (
                            <Field key={`${groupKey}-${key}`} label={label as string}>
                              <ControlTextarea
                                data-testid={`local-model-${groupKey}-${key}-input`}
                                value={stringValue((group as CatalogObject)[key as string])}
                                onChange={event =>
                                  updateMessageGroup(groupKey as string, group as CatalogObject, {
                                    [key as string]: nullableString(event.target.value),
                                  })
                                }
                                className="w-full resize-y min-h-24"
                              />
                            </Field>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </DialogSurface>
          </div>,
          document.body
        )}
    </section>
  )
}
