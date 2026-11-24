import type { SetStateAction } from 'react'
import { beginSmartAppPublication } from '@/features/harness-apps/smartAppOperations'
import type {
  SmartAppAccessTarget,
  SmartAppMarketplaceItem,
  SmartAppSubmissionMetadata,
  SmartAppsApi,
} from '@/api/smartApps'
import {
  harnessAppsApi,
  type HarnessAppInstallation,
  type HarnessAppManifest,
} from '@/api/local/harnessApps'
import type { useTranslation } from '@/hooks/useTranslation'
import { getSmartAppErrorMessage } from '@/lib/smart-app-error-message'
import {
  readDataUrl,
  validatePublishImage,
  readManifest,
  MAX_SMART_APP_PACKAGE_BYTES,
} from './smartAppsMarketplaceHelpers'

interface PublicationSnapshot {
  file: File | null
  manifest: HarnessAppManifest | null
  summary: string
  description: string
  selectedTags: string[]
  icon: File | null
  screenshots: File[]
  notes: string
  scope: 'restricted' | 'public'
  targets: SmartAppAccessTarget[]
  publishing: boolean
  error: string | null
}
interface PublicationTarget {
  item: SmartAppMarketplaceItem | null
  installation: HarnessAppInstallation | null
}
export function createMarketplacePublicationSource(api: SmartAppsApi, initial: PublicationTarget) {
  let { item, installation } = initial
  let snapshot: PublicationSnapshot = {
    file: null,
    manifest: installation?.manifest ?? null,
    summary: item?.summary ?? installation?.manifest.description ?? '',
    description: item?.descriptionMd ?? '',
    selectedTags: item?.tags ?? [],
    icon: null,
    screenshots: [],
    notes: '',
    scope: 'restricted',
    targets: [],
    publishing: false,
    error: null,
  }
  let generation = 0,
    packageRequest = 0
  const listeners = new Set<() => void>()
  let input: { t: ReturnType<typeof useTranslation>['t']; onPublished(): void } | null = null
  const publishSnapshot = (change: Partial<PublicationSnapshot>) => {
    snapshot = { ...snapshot, ...change }
    listeners.forEach(listener => listener())
  }
  const setFile = (value: SetStateAction<PublicationSnapshot['file']>) =>
    publishSnapshot({ file: typeof value === 'function' ? value(snapshot.file) : value })
  const setManifest = (value: SetStateAction<PublicationSnapshot['manifest']>) =>
    publishSnapshot({ manifest: typeof value === 'function' ? value(snapshot.manifest) : value })
  const setSummary = (value: SetStateAction<PublicationSnapshot['summary']>) =>
    publishSnapshot({ summary: typeof value === 'function' ? value(snapshot.summary) : value })
  const setDescription = (value: SetStateAction<PublicationSnapshot['description']>) =>
    publishSnapshot({
      description: typeof value === 'function' ? value(snapshot.description) : value,
    })
  const setSelectedTags = (value: SetStateAction<PublicationSnapshot['selectedTags']>) =>
    publishSnapshot({
      selectedTags: typeof value === 'function' ? value(snapshot.selectedTags) : value,
    })
  const setIcon = (value: SetStateAction<PublicationSnapshot['icon']>) =>
    publishSnapshot({ icon: typeof value === 'function' ? value(snapshot.icon) : value })
  const setScreenshots = (value: SetStateAction<PublicationSnapshot['screenshots']>) =>
    publishSnapshot({
      screenshots: typeof value === 'function' ? value(snapshot.screenshots) : value,
    })
  const setNotes = (value: SetStateAction<PublicationSnapshot['notes']>) =>
    publishSnapshot({ notes: typeof value === 'function' ? value(snapshot.notes) : value })
  const setScope = (value: SetStateAction<PublicationSnapshot['scope']>) =>
    publishSnapshot({ scope: typeof value === 'function' ? value(snapshot.scope) : value })
  const setTargets = (value: SetStateAction<PublicationSnapshot['targets']>) =>
    publishSnapshot({ targets: typeof value === 'function' ? value(snapshot.targets) : value })
  const setPublishing = (value: SetStateAction<PublicationSnapshot['publishing']>) =>
    publishSnapshot({
      publishing: typeof value === 'function' ? value(snapshot.publishing) : value,
    })
  const setError = (value: SetStateAction<PublicationSnapshot['error']>) =>
    publishSnapshot({ error: typeof value === 'function' ? value(snapshot.error) : value })
  async function choosePackage(next: File | null) {
    if (!input || !listeners.size) return
    const { t } = input
    const request = ++packageRequest,
      version = generation
    const isCurrent = () =>
      listeners.size > 0 && version === generation && request === packageRequest
    setFile(next)
    setManifest(null)
    setError(null)
    if (!next) return
    try {
      if (next.size > MAX_SMART_APP_PACKAGE_BYTES) {
        throw new Error(
          t(
            'workbench.smart_apps_error_package_too_large',
            '发布包超过 50 MB，请使用项目打包命令生成发布产物，不要直接上传源码压缩包。'
          )
        )
      }
      const parsed = await readManifest(next, {
        missingManifest: t(
          'workbench.smart_apps_manifest_required',
          '发布包必须包含且只能包含一个 plugin-manifest.json'
        ),
        invalidPackage: t('workbench.smart_apps_invalid_package', '不是有效的智能工作台发布包'),
      })
      if (!isCurrent()) return
      if (item && parsed.name !== item.name) {
        throw new Error(
          t('workbench.smart_apps_version_name_mismatch', '新版本的工作台名称必须与原工作台一致')
        )
      }
      setManifest(parsed)
      setSummary(value => value || parsed.description)
    } catch (value) {
      if (!isCurrent()) return
      setError(
        getSmartAppErrorMessage(
          value,
          t('workbench.smart_apps_package_parse_failed', '发布包解析失败'),
          t
        )
      )
    }
  }
  async function publish() {
    if (!input || !listeners.size || snapshot.publishing) return
    const { t, onPublished } = input
    const publicationItem = item,
      publicationInstallation = installation
    const version = generation
    const isCurrent = () => listeners.size > 0 && version === generation
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
    } = snapshot
    if (
      (!file && !publicationInstallation) ||
      !manifest ||
      (!icon && !publicationItem?.iconUrl) ||
      !summary.trim() ||
      !selectedTags.length
    ) {
      setError(
        t('workbench.smart_apps_publish_fields_required', '请完整填写发布包、简介、标签和图标')
      )
      return
    }
    if (!publicationItem && scope === 'restricted' && !targets.length) {
      setError(
        t('workbench.smart_apps_first_target_required', '首次发布必须选择至少一个成员或部门')
      )
      return
    }
    const iconError = icon ? validatePublishImage(icon, 'icon', t) : null
    if (iconError) {
      setError(iconError)
      return
    }
    const screenshotError = screenshots
      .map(value => validatePublishImage(value, 'screenshot', t))
      .find((value): value is string => Boolean(value))
    if (screenshotError) {
      setError(screenshotError)
      return
    }
    setPublishing(true)
    setError(null)
    const attempt = beginSmartAppPublication()
    try {
      const imageErrorMessage = t(
        'workbench.smart_apps_error_image_invalid',
        '图片无法读取，请重新选择有效的图片文件。'
      )
      const iconDataUrl = icon ? await readDataUrl(icon, imageErrorMessage) : undefined
      const screenshotDataUrls =
        screenshots.length || !publicationItem
          ? await Promise.all(
              screenshots.slice(0, 5).map(value => readDataUrl(value, imageErrorMessage))
            )
          : undefined
      const metadataBase = {
        name: manifest.name,
        displayName: manifest.displayName,
        version: manifest.version,
        summary: summary.trim(),
        descriptionMd: description,
        tags: selectedTags,
        releaseNotes: notes,
      }
      let metadata: SmartAppSubmissionMetadata
      if (publicationItem) {
        metadata = {
          ...metadataBase,
          smartAppId: publicationItem.id,
          targets: [],
          ...(iconDataUrl ? { iconDataUrl } : {}),
          ...(screenshotDataUrls ? { screenshotDataUrls } : {}),
        }
      } else {
        if (!iconDataUrl) {
          throw new Error(
            t('workbench.smart_apps_publish_fields_required', '请完整填写发布包、简介、标签和图标')
          )
        }
        metadata = {
          ...metadataBase,
          scope,
          targets: scope === 'restricted' ? targets : [],
          iconDataUrl,
          ...(screenshotDataUrls ? { screenshotDataUrls } : {}),
        }
      }
      if (!isCurrent()) {
        attempt.fail()
        return
      }
      if (publicationInstallation) {
        const exported = await harnessAppsApi.export(publicationInstallation.id)
        if (exported.sizeBytes > MAX_SMART_APP_PACKAGE_BYTES) {
          throw new Error(
            t(
              'workbench.smart_apps_error_package_too_large',
              '发布包超过 50 MB，请使用项目打包命令生成发布产物，不要直接上传源码压缩包。'
            )
          )
        }
        if (!isCurrent()) {
          attempt.fail()
          return
        }
        const initialized = await api.initSubmission(
          {
            filename: `${exported.manifest.name}-${exported.manifest.version}.zip`,
            sha256: exported.sha256,
            sizeBytes: exported.sizeBytes,
          },
          metadata
        )
        try {
          await harnessAppsApi.upload(exported.archivePath, initialized.uploadUrl)
          attempt.submitted(await api.completeSubmission(initialized.submissionId))
        } catch (value) {
          attempt.fail()
          await api.cancelSubmission(initialized.submissionId).catch(() => undefined)
          throw value
        }
      } else {
        attempt.submitted(await api.publish(file!, metadata))
      }
      if (isCurrent()) onPublished()
    } catch (value) {
      attempt.fail()
      setError(
        getSmartAppErrorMessage(
          value,
          t('workbench.smart_apps_publish_failed', '智能工作台发布失败'),
          t
        )
      )
    } finally {
      setPublishing(false)
    }
  }

  return {
    getSnapshot: () => snapshot,
    setFile,
    setManifest,
    setSummary,
    setDescription,
    setSelectedTags,
    setIcon,
    setScreenshots,
    setNotes,
    setScope,
    setTargets,
    setPublishing,
    setError,
    choosePackage,
    publish,
    subscribe(listener: () => void, next: NonNullable<typeof input> & PublicationTarget) {
      input = next
      item = next.item
      installation = next.installation
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size) return
          generation++
          packageRequest++
        })
      }
    },
  }
}
