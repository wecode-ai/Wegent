import { getErrorMessage } from '@/lib/error-message'

export type SmartAppTranslate = (key: string, fallback: string) => string

interface ErrorTranslation {
  pattern: RegExp
  key: string
  fallback: string
}

const ERROR_TRANSLATIONS: ErrorTranslation[] = [
  {
    pattern: /^(?:Smart app package is too large|Smart app ZIP exceeds 50 MB)$/i,
    key: 'workbench.smart_apps_error_package_too_large',
    fallback: '发布包超过 50 MB，请使用项目打包命令生成发布产物，不要直接上传源码压缩包。',
  },
  {
    pattern: /^(?:Smart app ZIP expands beyond 250 MB|Smart app directory exceeds 250 MB)$/i,
    key: 'workbench.smart_apps_error_extracted_package_too_large',
    fallback: '发布包解压后不能超过 250 MB，请精简文件后重新打包。',
  },
  {
    pattern: /^Smart app image is too large$/i,
    key: 'workbench.smart_apps_error_image_too_large',
    fallback: '图标不能超过 512 KB，单张截图不能超过 2 MB。',
  },
  {
    pattern: /^Smart app icon must be PNG or WebP$/i,
    key: 'workbench.smart_apps_error_icon_format',
    fallback: '图标仅支持 PNG 或 WebP 格式。',
  },
  {
    pattern: /^(?:Unsupported Smart app image|Smart app image is invalid)$/i,
    key: 'workbench.smart_apps_error_image_invalid',
    fallback: '图片无法读取，请重新选择有效的图片文件。',
  },
  {
    pattern: /^Smart app version already exists$/i,
    key: 'workbench.smart_apps_error_version_exists',
    fallback: '该版本已发布，请提升版本号后重试。',
  },
  {
    pattern: /^Smart app version must be newer than latest$/i,
    key: 'workbench.smart_apps_error_version_not_newer',
    fallback: '新版本号必须高于当前已发布版本。',
  },
  {
    pattern: /^(?:Invalid Smart app share user|Invalid Smart app share department)$/i,
    key: 'workbench.smart_apps_error_share_target_invalid',
    fallback: '分享成员或部门无效，请重新选择。',
  },
  {
    pattern: /^Department is not accessible$/i,
    key: 'workbench.smart_apps_error_department_inaccessible',
    fallback: '无权访问所选部门，请重新选择。',
  },
  {
    pattern:
      /^(?:Invalid Smart app ZIP|Smart app manifest is invalid|plugin-manifest\.json is invalid)$/i,
    key: 'workbench.smart_apps_error_package_invalid',
    fallback: '发布包无效，请重新生成发布产物后重试。',
  },
  {
    pattern:
      /^(?:Smart app ZIP must contain one plugin-manifest\.json|Smart app ZIP contains multiple plugin-manifest\.json files|plugin-manifest\.json is missing)$/i,
    key: 'workbench.smart_apps_manifest_required',
    fallback: '发布包必须包含且只能包含一个 plugin-manifest.json。',
  },
  {
    pattern: /^(?:Unsupported Smart app package type|Smart app package is invalid)$/i,
    key: 'workbench.smart_apps_invalid_package',
    fallback: '不是有效的智能工作台发布包。',
  },
  {
    pattern: /^Smart app package contains a sensitive file:/i,
    key: 'workbench.smart_apps_error_sensitive_file',
    fallback: '发布包中包含敏感文件，请移除后重新打包。',
  },
  {
    pattern: /^Smart app package contains a symbolic link$/i,
    key: 'workbench.smart_apps_error_symlink',
    fallback: '发布包中不能包含符号链接。',
  },
  {
    pattern:
      /^(?:Smart app version is invalid|Smart app version must be SemVer|version must be SemVer)$/i,
    key: 'workbench.smart_apps_error_version_invalid',
    fallback: '版本号不符合 SemVer 规范。',
  },
  {
    pattern:
      /^(?:Smart app requirements are incomplete|Smart app runtime requirements are invalid)$/i,
    key: 'workbench.smart_apps_error_requirements_invalid',
    fallback: '发布包的 DSH 或 Node.js 运行环境要求不完整。',
  },
  {
    pattern: /^Request parameter validation failed$/i,
    key: 'workbench.smart_apps_error_request_invalid',
    fallback: '发布信息校验失败，请检查发布包、图片、标签和分享范围。',
  },
]

const FIELD_TRANSLATIONS: Record<string, Omit<ErrorTranslation, 'pattern'>> = {
  sizeBytes: {
    key: 'workbench.smart_apps_error_package_too_large',
    fallback: '发布包超过 50 MB，请使用项目打包命令生成发布产物，不要直接上传源码压缩包。',
  },
  summary: {
    key: 'workbench.smart_apps_error_summary_invalid',
    fallback: '一句话简介必须为 1–500 个字符。',
  },
  descriptionMd: {
    key: 'workbench.smart_apps_error_description_too_long',
    fallback: '详细介绍不能超过 8192 个字符。',
  },
  tags: {
    key: 'workbench.smart_apps_error_tags_invalid',
    fallback: '请选择 1–3 个市场标签。',
  },
  iconDataUrl: {
    key: 'workbench.smart_apps_error_image_invalid',
    fallback: '图标无法读取，请重新选择 PNG 或 WebP 图片。',
  },
  screenshotDataUrls: {
    key: 'workbench.smart_apps_error_image_invalid',
    fallback: '截图无法读取，请重新选择图片。',
  },
  releaseNotes: {
    key: 'workbench.smart_apps_error_release_notes_too_long',
    fallback: '版本说明不能超过 4096 个字符。',
  },
  scope: {
    key: 'workbench.smart_apps_error_scope_invalid',
    fallback: '发布范围无效，请重新选择。',
  },
  targets: {
    key: 'workbench.smart_apps_error_share_target_invalid',
    fallback: '分享成员或部门无效，请重新选择。',
  },
}

interface SmartAppApiError {
  errorCode?: unknown
  detail?: unknown
}

function asSmartAppApiError(error: unknown): SmartAppApiError | null {
  return error !== null && typeof error === 'object' ? (error as SmartAppApiError) : null
}

function validationField(error: SmartAppApiError): string | null {
  if (!error.detail || typeof error.detail !== 'object') return null
  const errors = (error.detail as { errors?: unknown }).errors
  if (!Array.isArray(errors)) return null
  for (const item of errors) {
    if (!item || typeof item !== 'object') continue
    const location = (item as { loc?: unknown }).loc
    if (!Array.isArray(location)) continue
    const field = [...location]
      .reverse()
      .find(value => typeof value === 'string' && FIELD_TRANSLATIONS[value])
    if (typeof field === 'string') return field
  }
  return null
}

function translatedMessage(message: string, t: SmartAppTranslate): string | null {
  const translation = ERROR_TRANSLATIONS.find(item => item.pattern.test(message))
  return translation ? t(translation.key, translation.fallback) : null
}

export function getSmartAppErrorMessage(
  error: unknown,
  fallback: string,
  t: SmartAppTranslate
): string {
  const apiError = asSmartAppApiError(error)
  if (apiError?.errorCode === 'smart_app_storage_unavailable') {
    return t('workbench.smart_apps_storage_unavailable', '文件存储服务暂不可用，请稍后重试')
  }
  if (apiError) {
    const field = validationField(apiError)
    if (field) {
      const translation = FIELD_TRANSLATIONS[field]
      return t(translation.key, translation.fallback)
    }
  }
  const message = getErrorMessage(error, fallback)
  const translated = translatedMessage(message, t)
  if (translated) return translated
  if (/[\u4e00-\u9fff]/.test(message)) return message
  return /[\u4e00-\u9fff]/.test(fallback) ? fallback : message
}

export function localizeSmartAppIssue(
  issue: string,
  fallback: string,
  t: SmartAppTranslate
): string {
  return getSmartAppErrorMessage(new Error(issue), fallback, t)
}
