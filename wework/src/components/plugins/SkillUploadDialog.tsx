import { AlertCircle, FileArchive, Loader2, Upload, X } from 'lucide-react'
import type { DragEvent } from 'react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  readSkillPackageInfo,
  type SkillPackageInfo,
} from './skill-upload-utils'

const MAX_FILE_SIZE = 10 * 1024 * 1024

interface SelectedSkillPackage {
  file: File
  info: SkillPackageInfo
}

function formatFileSize(size: number): string {
  return `${(size / (1024 * 1024)).toFixed(2)} MB`
}

export function SkillUploadDialog({
  isUploading,
  onCancel,
  onUpload,
}: {
  isUploading: boolean
  onCancel: () => void
  onUpload: (file: File, name: string) => Promise<void>
}) {
  const { t } = useTranslation('common')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [selectedPackage, setSelectedPackage] =
    useState<SelectedSkillPackage | null>(null)
  const [skillName, setSkillName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const selectFile = async (file: File) => {
    setError(null)

    if (!/\.zip$/i.test(file.name)) {
      setSelectedPackage(null)
      setSkillName('')
      setError(t('workbench.plugins_skill_upload_zip_error', '请选择 .zip 技能安装包'))
      return
    }
    if (file.size > MAX_FILE_SIZE) {
      setSelectedPackage(null)
      setSkillName('')
      setError(t('workbench.plugins_skill_upload_size_error', '技能安装包不能超过 10MB'))
      return
    }

    try {
      const info = await readSkillPackageInfo(file)
      setSelectedPackage({ file, info })
      setSkillName(info.name)
    } catch (readError) {
      setSelectedPackage(null)
      setSkillName('')
      setError(
        readError instanceof Error
          ? readError.message
          : t('workbench.plugins_skill_upload_parse_error', '无法读取技能信息'),
      )
    }
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setIsDragging(false)

    const file = event.dataTransfer.files?.[0]
    if (file) void selectFile(file)
  }

  const handleDrag = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setIsDragging(event.type === 'dragenter' || event.type === 'dragover')
  }

  const submit = async () => {
    if (!selectedPackage) {
      setError(t('workbench.plugins_skill_upload_select_file', '请先选择技能安装包'))
      return
    }
    const name = skillName.trim()
    if (!name) {
      setError(t('workbench.plugins_skill_upload_name_error', '请填写技能名称'))
      return
    }

    setError(null)
    await onUpload(selectedPackage.file, name)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 px-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t('workbench.plugins_skill_upload_title', '上传技能')}
        className="w-full max-w-[620px] rounded-2xl bg-base p-5 shadow-xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-text-primary">
              {t('workbench.plugins_skill_upload_title', '上传技能')}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              {t(
                'workbench.plugins_skill_upload_description',
                '拖入技能安装包，确认信息后完成上传。',
              )}
            </p>
          </div>
          <button
            type="button"
            aria-label={t('workbench.plugins_uninstall_cancel', '取消')}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-text-muted hover:bg-surface"
            onClick={onCancel}
            disabled={isUploading}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div
          data-testid="skill-upload-dropzone"
          className={[
            'mt-5 flex min-h-[128px] cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed p-5 text-center transition-colors',
            isDragging
              ? 'border-primary bg-primary/5'
              : 'border-border bg-surface hover:border-primary/60',
            isUploading ? 'pointer-events-none opacity-60' : '',
          ].join(' ')}
          onClick={() => inputRef.current?.click()}
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            data-testid="skill-upload-file-input"
            disabled={isUploading}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void selectFile(file)
            }}
          />
          {selectedPackage ? (
            <>
              <FileArchive className="h-8 w-8 text-primary" />
              <p className="mt-2 text-sm font-semibold text-text-primary">
                {selectedPackage.file.name}
              </p>
              <p className="mt-1 text-xs text-text-muted">
                {formatFileSize(selectedPackage.file.size)}
              </p>
            </>
          ) : (
            <>
              <Upload className="h-8 w-8 text-text-muted" />
              <p className="mt-2 text-sm font-semibold text-text-primary">
                {t('workbench.plugins_skill_upload_drop_title', '拖入或选择技能安装包')}
              </p>
              <p className="mt-1 text-xs text-text-muted">
                {t('workbench.plugins_skill_upload_drop_hint', 'ZIP，最大 10MB')}
              </p>
            </>
          )}
        </div>

        {selectedPackage && (
          <div className="mt-5 grid grid-cols-2 gap-3">
            <label className="text-xs font-semibold text-text-secondary">
              {t('workbench.plugins_skill_upload_name', '技能名称')}
              <input
                value={skillName}
                data-testid="skill-upload-name-input"
                className="mt-2 h-10 w-full rounded-xl border border-border bg-base px-3 text-sm text-text-primary outline-none focus:border-primary"
                disabled={isUploading}
                onChange={(event) => setSkillName(event.target.value)}
              />
            </label>
            <InfoField
              label={t('workbench.plugins_skill_upload_version', '版本')}
              value={selectedPackage.info.version || '-'}
            />
            <div className="col-span-2">
              <InfoField
                label={t('workbench.plugins_skill_upload_description_label', '描述')}
                value={
                  selectedPackage.info.description ||
                  t('workbench.plugins_skill_upload_no_description', '未提供描述')
                }
              />
            </div>
            <InfoField
              label={t('workbench.plugins_skill_upload_author', '作者')}
              value={selectedPackage.info.author || '-'}
            />
            <InfoField
              label={t('workbench.plugins_skill_upload_tags', '标签')}
              value={
                selectedPackage.info.tags.length > 0
                  ? selectedPackage.info.tags.join(', ')
                  : '-'
              }
            />
          </div>
        )}

        {error && (
          <div className="mt-4 flex items-center gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm font-medium text-red-600">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="h-9 rounded-xl px-4 text-sm font-semibold text-text-secondary hover:bg-surface"
            onClick={onCancel}
            disabled={isUploading}
          >
            {t('workbench.plugins_uninstall_cancel', '取消')}
          </button>
          <button
            type="button"
            data-testid="skill-upload-confirm-button"
            className="flex h-9 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
            onClick={() => void submit()}
            disabled={isUploading || !selectedPackage}
          >
            {isUploading && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('workbench.plugins_skill_upload_confirm', '上传')}
          </button>
        </div>
      </section>
    </div>
  )
}

function InfoField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl bg-surface px-3 py-2">
      <p className="text-xs font-semibold text-text-muted">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold text-text-primary">
        {value}
      </p>
    </div>
  )
}
