import { ChevronDown, FolderOpen, Loader2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SmartAppTemplate } from '@/api/local/harnessApps'
import { Button } from '@/components/ui/button'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { getErrorMessage } from '@/lib/error-message'
import { openNativeDirectoryPicker } from '@/lib/native-directory-picker'
import {
  getSmartAppErrorMessage,
  isOutdatedSmartAppCreationHost,
  isSmartAppSaveLocationError,
} from '@/lib/smart-app-error-message'

export interface SmartAppDevelopmentInput {
  parentPath: string
  name: string
  displayName: string
  description: string
  template: SmartAppTemplate
}

const SMART_APP_TEMPLATES: Array<{
  value: SmartAppTemplate
  labelKey: string
  label: string
  descriptionKey: string
  description: string
}> = [
  {
    value: 'web',
    labelKey: 'workbench.smart_apps_template_web',
    label: 'Web',
    descriptionKey: 'workbench.smart_apps_template_web_description',
    description: '仅包含浏览器界面。',
  },
  {
    value: 'host',
    labelKey: 'workbench.smart_apps_template_host',
    label: 'Host',
    descriptionKey: 'workbench.smart_apps_template_host_description',
    description: '仅包含本地 Host 逻辑。',
  },
  {
    value: 'web-host',
    labelKey: 'workbench.smart_apps_template_web_host',
    label: 'Web + Host',
    descriptionKey: 'workbench.smart_apps_template_web_host_description',
    description: '包含界面与本地 Host 逻辑。',
  },
  {
    value: 'web-host-remote',
    labelKey: 'workbench.smart_apps_template_web_host_remote',
    label: 'Web + Host + Remote',
    descriptionKey: 'workbench.smart_apps_template_web_host_remote_description',
    description: '包含界面、Host 与类型化远程调用。',
  },
]

interface SmartAppDevelopmentDialogProps {
  mode: 'create' | 'copy'
  initialDisplayName?: string
  onClose: () => void
  onSubmit: (input: SmartAppDevelopmentInput) => Promise<void>
}

function smartAppSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

export function SmartAppDevelopmentDialog({
  mode,
  initialDisplayName = '',
  onClose,
  onSubmit,
}: SmartAppDevelopmentDialogProps) {
  const { t } = useTranslation('common')
  const [displayName, setDisplayName] = useState(initialDisplayName)
  const [generatedName] = useState(() => `workbench-${crypto.randomUUID().slice(0, 8)}`)
  const [name, setName] = useState(() => smartAppSlug(initialDisplayName) || generatedName)
  const [nameEdited, setNameEdited] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [description, setDescription] = useState('')
  const [parentPath, setParentPath] = useState('')
  const [template, setTemplate] = useState<SmartAppTemplate>('web')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorDetail, setErrorDetail] = useState<string | null>(null)
  const [showChooseLocation, setShowChooseLocation] = useState(false)
  const valid = useMemo(
    () =>
      Boolean(displayName.trim()) &&
      (mode === 'create' || Boolean(name.trim() && parentPath.trim())),
    [displayName, mode, name, parentPath]
  )

  useEscapeKey(onClose, !submitting)

  async function chooseDirectory() {
    try {
      const selected = await openNativeDirectoryPicker()
      if (selected) {
        setParentPath(selected)
        setError(null)
        setShowChooseLocation(false)
      }
    } catch (value) {
      setError(
        getSmartAppErrorMessage(
          value,
          t(
            'workbench.smart_apps_choose_directory_failed',
            '无法打开目录选择器，请粘贴目录的绝对路径。'
          ),
          t
        )
      )
      setShowChooseLocation(false)
    }
  }

  async function submit() {
    if (!valid || submitting) return
    setSubmitting(true)
    setError(null)
    setErrorDetail(null)
    setShowChooseLocation(false)
    const input = {
      parentPath: parentPath.trim(),
      name:
        mode === 'create' ? name.trim() || smartAppSlug(displayName) || generatedName : name.trim(),
      displayName: displayName.trim(),
      description: description.trim(),
      template,
    }
    try {
      await onSubmit(input)
      onClose()
    } catch (value) {
      setShowChooseLocation(isSmartAppSaveLocationError(value))
      const message =
        mode === 'create' && isOutdatedSmartAppCreationHost(value, input)
          ? t(
              'workbench.smart_apps_host_restart_required',
              '桌面程序尚未更新到支持留空保存位置和用途说明的版本，请退出并重新启动后重试。'
            )
          : getSmartAppErrorMessage(
              value,
              t('workbench.smart_apps_development_failed', '创建智能工作台失败。'),
              t
            )
      const errorCode =
        value && typeof value === 'object' && 'code' in value && typeof value.code === 'string'
          ? value.code
          : null
      const rawMessage = getErrorMessage(value, '')
      const detail = errorCode && rawMessage ? `${errorCode}: ${rawMessage}` : rawMessage
      setError(message)
      setErrorDetail(detail && detail !== message ? detail : null)
    } finally {
      setSubmitting(false)
    }
  }

  const title =
    mode === 'create'
      ? t('workbench.smart_apps_create_title', '创建空白工作台')
      : t('workbench.smart_apps_copy_title', '复制为我的工作台')
  const directoryNameField = (
    <label className="grid gap-1.5 text-sm text-text-secondary">
      <span>{t('workbench.smart_apps_directory_name', '目录标识')}</span>
      <input
        data-testid="smart-app-development-name"
        value={name}
        disabled={submitting}
        onChange={event => {
          setNameEdited(true)
          setName(smartAppSlug(event.target.value))
          setError(null)
        }}
        className="h-9 rounded-lg border border-border/50 bg-background px-3 font-mono text-sm text-text-primary outline-none focus:border-focus focus:ring-2 focus:ring-focus/15"
      />
      {mode === 'create' ? (
        <span className="text-xs">
          {t('workbench.smart_apps_directory_name_hint', '留空则自动生成。')}
        </span>
      ) : null}
    </label>
  )

  return createPortal(
    <div className="plugin-dialog-overlay fixed inset-0 z-modal flex items-end justify-center sm:items-center sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="smart-app-development-title"
        data-testid="smart-app-development-dialog"
        className="plugin-dialog-surface max-h-[100dvh] w-full max-w-xl overflow-y-auto p-5 sm:max-h-[calc(100dvh-2rem)]"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="smart-app-development-title" className="heading-small">
              {title}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              {mode === 'create'
                ? t(
                    'workbench.smart_apps_create_description',
                    '按所需能力创建可直接运行和持续开发的本地目录。'
                  )
                : t(
                    'workbench.smart_apps_copy_description',
                    '市场版本保持不变，副本将成为独立、可编辑的本地工作台。'
                  )}
            </p>
          </div>
          <button
            type="button"
            aria-label={t('common.close', '关闭')}
            data-testid="smart-app-development-close"
            disabled={submitting}
            onClick={onClose}
            className="flex h-11 w-11 items-center justify-center rounded-md text-text-secondary hover:bg-muted disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 grid gap-4">
          <label className="grid gap-1.5 text-sm text-text-secondary">
            <span>{t('workbench.smart_apps_display_name', '工作台名称')}</span>
            <input
              autoFocus
              data-testid="smart-app-development-display-name"
              value={displayName}
              disabled={submitting}
              onChange={event => {
                const value = event.target.value
                setDisplayName(value)
                if (!nameEdited) setName(smartAppSlug(value) || generatedName)
                setError(null)
              }}
              className="h-9 rounded-lg border border-border/50 bg-background px-3 text-sm text-text-primary outline-none focus:border-focus focus:ring-2 focus:ring-focus/15"
            />
          </label>

          {mode === 'create' ? (
            <label className="grid gap-1.5 text-sm text-text-secondary">
              <span>{t('workbench.smart_apps_description_optional', '用途说明（可选）')}</span>
              <textarea
                data-testid="smart-app-development-description"
                value={description}
                disabled={submitting}
                rows={3}
                onChange={event => setDescription(event.target.value)}
                className="resize-none rounded-lg border border-border/50 bg-background px-3 py-2 text-sm text-text-primary outline-none focus:border-focus focus:ring-2 focus:ring-focus/15"
              />
            </label>
          ) : null}

          {mode === 'copy' ? directoryNameField : null}

          <label className="grid gap-1.5 text-sm text-text-secondary">
            <span>
              {mode === 'create'
                ? t('workbench.smart_apps_parent_directory_optional', '保存位置（可选）')
                : t('workbench.smart_apps_parent_directory', '保存位置')}
            </span>
            <div className="flex gap-2">
              <input
                data-testid="smart-app-development-parent-path"
                value={parentPath}
                disabled={submitting}
                aria-describedby={
                  mode === 'create' ? 'smart-app-development-default-location-hint' : undefined
                }
                placeholder={
                  mode === 'create'
                    ? t(
                        'workbench.smart_apps_parent_directory_optional_placeholder',
                        '留空使用默认位置'
                      )
                    : t(
                        'workbench.smart_apps_parent_directory_placeholder',
                        '选择父目录或粘贴绝对路径'
                      )
                }
                onChange={event => {
                  setParentPath(event.target.value)
                  setError(null)
                  setShowChooseLocation(false)
                }}
                className="h-9 min-w-0 flex-1 rounded-lg border border-border/50 bg-background px-3 font-mono text-sm text-text-primary outline-none focus:border-focus focus:ring-2 focus:ring-focus/15"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="smart-app-development-choose-directory"
                disabled={submitting}
                onClick={() => void chooseDirectory()}
              >
                <FolderOpen className="h-4 w-4" />
                {t('workbench.smart_apps_choose_directory', '选择')}
              </Button>
            </div>
            {mode === 'create' ? (
              <span id="smart-app-development-default-location-hint" className="text-xs">
                {t(
                  'workbench.smart_apps_default_location_hint',
                  '留空则保存到系统“文档”中的 WeworkSmartApps 文件夹。'
                )}
              </span>
            ) : null}
          </label>

          {mode === 'create' ? (
            <div>
              <button
                type="button"
                aria-expanded={advancedOpen}
                aria-controls="smart-app-development-advanced-options"
                data-testid="smart-app-development-advanced-toggle"
                disabled={submitting}
                onClick={() => setAdvancedOpen(open => !open)}
                className="flex w-full min-h-11 items-center justify-between rounded-lg text-left text-sm text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 disabled:opacity-50"
              >
                {t('workbench.smart_apps_advanced', '高级')}
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
                  aria-hidden="true"
                />
              </button>
              <div
                id="smart-app-development-advanced-options"
                className={advancedOpen ? 'grid gap-4 pt-2' : undefined}
              >
                {advancedOpen ? (
                  <>
                    {directoryNameField}
                    <fieldset className="grid gap-2">
                      <legend className="text-sm text-text-secondary">
                        {t('workbench.smart_apps_template', '能力模板')}
                      </legend>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {SMART_APP_TEMPLATES.map(option => {
                          const selected = template === option.value
                          return (
                            <button
                              key={option.value}
                              type="button"
                              aria-pressed={selected}
                              data-testid={`smart-app-development-template-${option.value}`}
                              disabled={submitting}
                              onClick={() => setTemplate(option.value)}
                              className={`min-h-11 rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 ${
                                selected
                                  ? 'border-text-primary bg-muted text-text-primary'
                                  : 'border-border/50 text-text-secondary hover:bg-muted/50'
                              }`}
                            >
                              <span className="block text-sm font-medium">
                                {t(option.labelKey, option.label)}
                              </span>
                              <span className="mt-0.5 block text-xs">
                                {t(option.descriptionKey, option.description)}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    </fieldset>
                    <div className="rounded-lg border border-border/50 bg-surface/30 px-3 py-2 text-xs text-text-secondary">
                      {t(
                        'workbench.smart_apps_template_hint',
                        '模板只声明起步所需能力；后续可按实际需求调整代码与验证契约。'
                      )}
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        {error ? (
          <div className="mt-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
              {showChooseLocation ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="smart-app-development-choose-other-directory"
                  disabled={submitting}
                  onClick={() => void chooseDirectory()}
                >
                  <FolderOpen className="h-4 w-4" />
                  {t('workbench.smart_apps_choose_other_directory', '选择其他目录')}
                </Button>
              ) : null}
            </div>
            {errorDetail ? (
              <details className="text-xs text-text-secondary">
                <summary
                  className="cursor-pointer"
                  data-testid="smart-app-development-error-details"
                >
                  {t('workbench.smart_apps_error_details', '查看错误详情')}
                </summary>
                <p className="mt-1 break-all font-mono">{errorDetail}</p>
              </details>
            ) : null}
          </div>
        ) : null}

        <div className="mt-6 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            data-testid="smart-app-development-cancel"
            disabled={submitting}
            onClick={onClose}
          >
            {t('common.cancel', '取消')}
          </Button>
          <Button
            type="button"
            data-testid="smart-app-development-confirm"
            disabled={!valid || submitting}
            onClick={() => void submit()}
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {mode === 'create'
              ? t('workbench.smart_apps_create_and_develop', '创建并开发')
              : t('workbench.smart_apps_copy_and_develop', '复制并开发')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
