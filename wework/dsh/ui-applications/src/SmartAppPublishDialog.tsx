import { useState, useCallback, useSyncExternalStore } from 'react'
import { createMarketplacePublicationSource } from './marketplacePublicationSource'
import { SmartAppFilePicker } from './SmartAppFilePicker'
import { CheckCircle2, Loader2, X } from 'lucide-react'
import type { SmartAppMarketplaceItem, SmartAppMarketplaceTag, SmartAppsApi } from '@/api/smartApps'
import { type HarnessAppInstallation } from '@/api/local/harnessApps'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { TargetPicker } from './SmartAppsMarketplaceAccess'
export function SmartAppPublishDialog({
  api,
  item,
  installation,
  tags,
  onClose,
  onPublished,
}: {
  api: SmartAppsApi
  item: SmartAppMarketplaceItem | null
  installation: HarnessAppInstallation | null
  tags: SmartAppMarketplaceTag[]
  onClose: () => void
  onPublished: () => void
}) {
  const { t, i18n } = useTranslation('common')
  const [owner, setOwner] = useState(() => ({
    api,
    itemId: item?.id,
    installationId: installation?.id,
    source: createMarketplacePublicationSource(api, { item, installation }),
  }))
  if (owner.api !== api || owner.itemId !== item?.id || owner.installationId !== installation?.id)
    setOwner({
      api,
      itemId: item?.id,
      installationId: installation?.id,
      source: createMarketplacePublicationSource(api, { item, installation }),
    })
  const resource = owner.source
  const subscribe = useCallback(
    (listener: () => void) => resource.subscribe(listener, { item, installation, t, onPublished }),
    [resource, item, installation, t, onPublished]
  )
  const {
    file,
    manifest,
    summary,
    description,
    selectedTags,
    icon,
    screenshots,
    notes,
    scope,
    targets,
    publishing,
    error,
  } = useSyncExternalStore(subscribe, resource.getSnapshot, resource.getSnapshot)
  const {
    setSummary,
    setDescription,
    setSelectedTags,
    setIcon,
    setScreenshots,
    setNotes,
    setScope,
    setTargets,
    choosePackage,
    publish,
  } = resource
  return (
    <div className="plugin-dialog-overlay fixed inset-0 z-modal flex items-end justify-center sm:items-center sm:p-4">
      <section
        role="dialog"
        aria-modal="true"
        data-testid="smart-app-publish-dialog"
        className="plugin-dialog-surface max-h-[92vh] w-full max-w-2xl overflow-y-auto p-5"
      >
        <header className="flex justify-between">
          <div>
            <h2 className="heading-small">
              {item
                ? t('workbench.smart_apps_publish_version', '发布新版本')
                : t('workbench.smart_apps_publish_smart_app', '发布智能工作台')}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              {t('workbench.smart_apps_auto_publish_hint', '上传并通过安全扫描后自动发布')}
            </p>
          </div>
          <button
            aria-label={t('common.close', '关闭')}
            data-testid="smart-app-publish-close"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="mt-5 grid gap-4">
          {installation ? (
            <div className="rounded-xl border border-border/40 bg-surface p-3 text-sm">
              <div>
                <span className="font-medium">
                  {installation.source === 'linked'
                    ? t('workbench.smart_apps_publish_linked', '发布关联工作台')
                    : t('workbench.smart_apps_publish_installed', '发布已导入发布包')}
                </span>
                <span className="ml-2 text-text-muted">
                  {installation.manifest.displayName} · v{installation.manifest.version}
                </span>
              </div>
              <p className="mt-1 text-xs text-text-muted">
                {t(
                  installation.source === 'linked'
                    ? 'workbench.smart_apps_publish_linked_hint'
                    : 'workbench.smart_apps_publish_imported_hint',
                  installation.source === 'linked'
                    ? '发布前将校验当前源码目录并生成发布包。'
                    : '将使用已导入的发布包；源码目录请通过“关联文件夹”进入开发流程。'
                )}
              </p>
            </div>
          ) : (
            <div className="text-sm font-medium">
              <span>{t('workbench.smart_apps_zip', '智能工作台发布包（ZIP）')}</span>
              <SmartAppFilePicker
                inputTestId="smart-app-publish-package"
                label={t('workbench.smart_apps_zip', '智能工作台 ZIP')}
                accept=".zip,application/zip"
                files={file ? [file] : []}
                onChange={files => void choosePackage(files[0] ?? null)}
              />
              <p className="mt-1 text-xs font-normal text-text-muted">
                {t(
                  'workbench.smart_apps_publish_artifact_hint',
                  '发布时只接受项目打包命令生成的产物包，不要直接压缩源码目录。'
                )}
              </p>
            </div>
          )}
          {manifest ? (
            <div className="rounded-xl bg-surface p-3 text-sm">
              <strong>{manifest.displayName}</strong>
              <span className="ml-2 text-text-muted">
                {manifest.name} · v{manifest.version}
              </span>
            </div>
          ) : null}
          <label className="text-sm font-medium">
            {t('workbench.smart_apps_summary', '一句话简介')}
            <input
              value={summary}
              maxLength={500}
              className="mt-2 h-10 w-full rounded-lg border border-border px-3 font-normal"
              onChange={event => setSummary(event.target.value)}
            />
          </label>
          <label className="text-sm font-medium">
            {t('workbench.smart_apps_description_md', '详细介绍（Markdown）')}
            <textarea
              value={description}
              maxLength={8192}
              rows={5}
              className="mt-2 w-full rounded-lg border border-border p-3 font-normal"
              onChange={event => setDescription(event.target.value)}
            />
          </label>
          <fieldset>
            <legend className="text-sm font-medium">
              {t('workbench.smart_apps_tags', '市场标签（1–3 个）')}
            </legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {tags.map(tag => (
                <label
                  key={tag.id}
                  className="flex items-center gap-1 rounded-lg border px-2 py-1 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={selectedTags.includes(tag.id)}
                    disabled={!selectedTags.includes(tag.id) && selectedTags.length >= 3}
                    onChange={event =>
                      setSelectedTags(values =>
                        event.target.checked
                          ? [...values, tag.id]
                          : values.filter(value => value !== tag.id)
                      )
                    }
                  />
                  {i18n.language.startsWith('zh') ? tag.name_zh : tag.name_en}
                </label>
              ))}
            </div>
          </fieldset>
          {item && (item.iconUrl || item.screenshotUrls.length) ? (
            <div className="rounded-xl bg-surface p-3">
              <p className="text-xs text-text-muted">
                {t(
                  'workbench.smart_apps_inherit_assets_hint',
                  '不重新选择时，将沿用当前图标和截图。'
                )}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {item.iconUrl ? (
                  <img
                    src={item.iconUrl}
                    alt=""
                    data-testid="smart-app-publish-current-icon"
                    className="h-12 w-12 rounded-lg border border-border/40 object-cover"
                  />
                ) : null}
                {item.screenshotUrls.map((url, index) => (
                  <img
                    key={url}
                    src={url}
                    alt=""
                    data-testid={`smart-app-publish-current-screenshot-${index}`}
                    className="h-12 w-20 rounded-md border border-border/40 object-cover"
                  />
                ))}
              </div>
            </div>
          ) : null}
          <div className="text-sm font-medium">
            <span>{t('workbench.smart_apps_icon', '方形图标（PNG/WebP）')}</span>
            <SmartAppFilePicker
              inputTestId="smart-app-publish-icon"
              label={t('workbench.smart_apps_icon', '方形图标（PNG/WebP）')}
              accept="image/png,image/webp"
              emptyText={
                item ? t('workbench.smart_apps_keep_current_icon', '沿用当前图标') : undefined
              }
              files={icon ? [icon] : []}
              onChange={files => setIcon(files[0] ?? null)}
            />
          </div>
          <div className="text-sm font-medium">
            <span>{t('workbench.smart_apps_screenshots', '截图（最多 5 张）')}</span>
            <SmartAppFilePicker
              inputTestId="smart-app-publish-screenshots"
              label={t('workbench.smart_apps_screenshots', '截图（最多 5 张）')}
              accept="image/png,image/webp,image/jpeg"
              multiple
              emptyText={
                item
                  ? item.screenshotUrls.length
                    ? t(
                        'workbench.smart_apps_keep_current_screenshots',
                        '沿用当前 {{count}} 张截图'
                      ).replace('{{count}}', String(item.screenshotUrls.length))
                    : t('workbench.smart_apps_no_file_selected', '未选择文件')
                  : undefined
              }
              files={screenshots}
              onChange={files => setScreenshots(files.slice(0, 5))}
            />
          </div>
          <label className="text-sm font-medium">
            {t('workbench.smart_apps_release_notes', '版本说明')}
            <textarea
              value={notes}
              maxLength={4096}
              rows={3}
              className="mt-2 w-full rounded-lg border border-border p-3 font-normal"
              onChange={event => setNotes(event.target.value)}
            />
          </label>
          {item ? (
            <p className="text-sm text-text-secondary">
              {t(
                'workbench.smart_apps_inherit_access_hint',
                '新版本默认沿用当前分享范围，可发布后在“我的”中调整。'
              )}
            </p>
          ) : (
            <fieldset>
              <legend className="text-sm font-medium">
                {t('workbench.smart_apps_publish_scope', '发布范围')}
              </legend>
              <div className="mt-2 grid grid-cols-2 gap-2 rounded-xl bg-surface p-1">
                <button
                  type="button"
                  className={`h-11 rounded-lg ${scope === 'restricted' ? 'bg-background shadow-sm' : ''}`}
                  onClick={() => setScope('restricted')}
                  data-testid="smart-app-publish-scope-restricted"
                >
                  {t('workbench.smart_apps_restricted', '指定成员/部门')}
                </button>
                <button
                  type="button"
                  className={`h-11 rounded-lg ${scope === 'public' ? 'bg-background shadow-sm' : ''}`}
                  onClick={() => setScope('public')}
                  data-testid="smart-app-publish-scope-public"
                >
                  {t('workbench.smart_apps_public', '全员')}
                </button>
              </div>
              {scope === 'restricted' ? (
                <div className="mt-3">
                  <TargetPicker api={api} targets={targets} onChange={setTargets} />
                </div>
              ) : (
                <p className="mt-3 text-sm text-text-secondary">
                  {t(
                    'workbench.smart_apps_public_hint',
                    '发布成功后立即上架到智能应用市场，所有成员均可查看和安装。'
                  )}
                </p>
              )}
            </fieldset>
          )}
        </div>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        ) : null}
        <footer className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel', '取消')}
          </Button>
          <Button
            data-testid="smart-app-publish-submit"
            disabled={publishing}
            onClick={() => void publish()}
          >
            {publishing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('workbench.smart_apps_publishing', '发布中…')}
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4" />
                {t('workbench.smart_apps_publish', '发布')}
              </>
            )}
          </Button>
        </footer>
      </section>
    </div>
  )
}
