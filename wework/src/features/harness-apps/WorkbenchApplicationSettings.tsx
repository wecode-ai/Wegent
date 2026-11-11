import { useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import {
  harnessAppsApi,
  type HarnessAppInstallation,
  type WorkbenchPresentation,
} from '@/api/local/harnessApps'
import { Button } from '@/components/ui/button'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { useTranslation } from '@/hooks/useTranslation'
import { getSmartAppErrorMessage } from '@/lib/smart-app-error-message'

interface Props {
  installation: HarnessAppInstallation
  onClose: () => void
  onRefresh: () => Promise<void>
  onOpen: (
    installation: HarnessAppInstallation,
    presentation: WorkbenchPresentation
  ) => Promise<void>
}

export function WorkbenchApplicationSettings({ installation, onClose, onRefresh, onOpen }: Props) {
  const { t } = useTranslation('common')
  const [shortcutDraft, setShortcutDraft] = useState<{ id: string; value: string } | null>(null)
  const draft = shortcutDraft?.id === installation.id ? shortcutDraft : null
  const shortcut = draft?.value ?? installation.shortcut ?? ''
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useDialogKeyboard<HTMLDivElement>(() => {
    if (!pending) onClose()
  }, true)

  async function perform(action: () => Promise<unknown>, onSuccess?: () => void) {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      await action()
      await onRefresh()
      onSuccess?.()
    } catch (value) {
      setError(
        getSmartAppErrorMessage(
          value,
          t('workbench.workbench_configure_failed', '修改工作台设置失败。'),
          t
        )
      )
    } finally {
      setPending(false)
    }
  }

  return createPortal(
    <div className="plugin-dialog-overlay fixed inset-0 z-modal flex items-center justify-center p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="workbench-settings-title"
        data-testid="workbench-settings-dialog"
        className="plugin-dialog-surface max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto p-5"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id="workbench-settings-title" className="heading-small">
            {installation.manifest.displayName}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            data-testid="workbench-settings-close"
            aria-label={t('common.close', '关闭')}
            disabled={pending}
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="mt-4 grid gap-4 text-sm">
          <label className="grid gap-1.5">
            <span>{t('workbench.workbench_presentation', '打开方式')}</span>
            <select
              data-testid="workbench-presentation"
              value={installation.presentation ?? 'window'}
              disabled={pending}
              className="h-9 rounded-md border border-border bg-background px-2 text-text-primary"
              onChange={event => {
                const presentation = event.target.value as WorkbenchPresentation
                void perform(() =>
                  installation.state === 'running'
                    ? onOpen(installation, presentation)
                    : harnessAppsApi.configure(installation.id, { presentation })
                )
              }}
            >
              <option className="bg-background text-text-primary" value="window">
                {t('workbench.workbench_presentation_window', '独立窗口')}
              </option>
              <option className="bg-background text-text-primary" value="tab">
                {t('workbench.workbench_presentation_tab', '主窗口标签页')}
              </option>
            </select>
          </label>
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              data-testid="workbench-resident"
              checked={installation.resident}
              disabled={pending}
              onChange={event =>
                void perform(() =>
                  harnessAppsApi.configure(installation.id, { resident: event.target.checked })
                )
              }
            />
            {t('workbench.workbench_resident', '启动 Wework 时自动运行')}
          </label>
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              data-testid="workbench-background"
              checked={installation.background ?? true}
              disabled={pending}
              onChange={event =>
                void perform(() =>
                  harnessAppsApi.configure(installation.id, { background: event.target.checked })
                )
              }
            />
            {t('workbench.workbench_background', '关闭窗口后继续后台运行')}
          </label>
          <form
            className="grid gap-1.5"
            onSubmit={event => {
              event.preventDefault()
              void perform(
                () => harnessAppsApi.setShortcut(installation.id, shortcut.trim() || null),
                () => setShortcutDraft(null)
              )
            }}
          >
            <label htmlFor="workbench-shortcut">
              {t('workbench.workbench_shortcut', '全局快捷键')}
            </label>
            <input
              id="workbench-shortcut"
              data-testid="workbench-shortcut"
              className="h-9 rounded-md border border-border bg-background px-2 text-text-primary"
              value={shortcut}
              disabled={pending}
              onChange={event => {
                setShortcutDraft({ id: installation.id, value: event.target.value })
              }}
              placeholder="CommandOrControl+Shift+Y"
            />
            <p className="text-xs text-text-muted">
              {t(
                'workbench.workbench_shortcut_hint',
                '留空并保存可清除。工作台已聚焦时，快捷键会隐藏窗口。'
              )}
            </p>
            <Button
              type="submit"
              size="sm"
              variant="outline"
              data-testid="workbench-shortcut-save"
              disabled={pending || !draft}
            >
              {t('common.save', '保存')}
            </Button>
          </form>
          <Button
            variant="outline"
            data-testid="workbench-desktop-shortcut"
            disabled={pending}
            onClick={() => void perform(() => harnessAppsApi.createShortcut(installation.id))}
          >
            {t('workbench.workbench_desktop_shortcut', '创建桌面快捷方式')}
          </Button>
          {installation.shortcutError ? (
            <p role="alert" data-testid="workbench-shortcut-error" className="text-danger">
              {installation.shortcutError}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-danger">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </div>,
    document.body
  )
}
