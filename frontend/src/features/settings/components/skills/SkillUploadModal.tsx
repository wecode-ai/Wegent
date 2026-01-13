// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback } from 'react'
import { Skill } from '@/types/api'
import { uploadSkill, updateSkill, fetchSkillByName, UnifiedSkill } from '@/apis/skills'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Label } from '@/components/ui/label'
import { UploadIcon, FileIcon, AlertCircle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

interface SkillUploadModalProps {
  open: boolean
  onClose: (saved: boolean) => void
  skill?: Skill | UnifiedSkill | null
  namespace?: string // Namespace for the skill (default: 'default', group name for group skills)
}

// Helper to get skill name from either type
function getSkillName(skill: Skill | UnifiedSkill | null | undefined): string {
  if (!skill) return ''
  if ('metadata' in skill) {
    return skill.metadata.name || ''
  }
  return skill.name || ''
}

// Helper to get skill id from either type
function getSkillId(skill: Skill | UnifiedSkill | null | undefined): number {
  if (!skill) return 0
  if ('metadata' in skill) {
    return parseInt(skill.metadata.labels?.id || '0')
  }
  return skill.id || 0
}

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

export default function SkillUploadModal({
  open,
  onClose,
  skill,
  namespace: propNamespace,
}: SkillUploadModalProps) {
  const { t } = useTranslation()
  const [skillName, setSkillName] = useState(getSkillName(skill))
  const namespace = propNamespace || 'default'
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [overwriteDialogOpen, setOverwriteDialogOpen] = useState(false)
  const [existingSkill, setExistingSkill] = useState<Skill | null>(null)

  const isEditMode = !!skill

  const validateFile = (file: File): string | null => {
    if (!file.name.endsWith('.zip')) {
      return t('common:skills.error_file_format')
    }
    if (file.size > MAX_FILE_SIZE) {
      return t('common:skills.error_file_size', {
        fileSize: (file.size / (1024 * 1024)).toFixed(1),
      })
    }
    return null
  }

  const handleFileSelect = useCallback(
    (file: File) => {
      const validationError = validateFile(file)
      if (validationError) {
        setError(validationError)
        setSelectedFile(null)
        return
      }

      setSelectedFile(file)
      setError(null)

      // Auto-fill skill name from filename (without .zip extension)
      if (!isEditMode && !skillName) {
        const nameFromFile = file.name.replace(/\.zip$/i, '')
        setSkillName(nameFromFile)
      }
    },
    [isEditMode, skillName]
  )

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      handleFileSelect(file)
    }
  }

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true)
    } else if (e.type === 'dragleave') {
      setDragActive(false)
    }
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setDragActive(false)

      const file = e.dataTransfer.files?.[0]
      if (file) {
        handleFileSelect(file)
      }
    },
    [handleFileSelect]
  )

  const handleSubmit = async () => {
    if (!selectedFile) {
      setError(t('common:skills.error_select_file'))
      return
    }

    if (!isEditMode && !skillName.trim()) {
      setError(t('common:skills.error_enter_name'))
      return
    }

    // Check if skill with same name already exists (only for create mode)
    if (!isEditMode) {
      try {
        const existing = await fetchSkillByName(skillName.trim(), namespace)
        if (existing) {
          setExistingSkill(existing)
          setOverwriteDialogOpen(true)
          return
        }
      } catch {
        // Ignore errors when checking for existing skill
      }
    }

    await performUpload()
  }

  const performUpload = async (overwrite: boolean = false) => {
    if (!selectedFile) return

    setUploading(true)
    setError(null)
    setUploadProgress(0)

    try {
      if (isEditMode && skill) {
        const skillId = getSkillId(skill)
        await updateSkill(skillId, selectedFile, setUploadProgress)
      } else if (overwrite && existingSkill) {
        // Update existing skill
        const skillId = parseInt(existingSkill.metadata.labels?.id || '0')
        await updateSkill(skillId, selectedFile, setUploadProgress)
      } else {
        await uploadSkill(selectedFile, skillName.trim(), namespace, setUploadProgress)
      }
      onClose(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common:skills.error_upload_failed'))
    } finally {
      setUploading(false)
    }
  }

  const handleOverwriteConfirm = async () => {
    setOverwriteDialogOpen(false)
    await performUpload(true)
  }

  const handleOverwriteCancel = () => {
    setOverwriteDialogOpen(false)
    setExistingSkill(null)
  }

  const handleClose = () => {
    if (!uploading) {
      onClose(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={open => !open && handleClose()}>
        <DialogContent className="sm:max-w-[500px] bg-surface">
          <DialogHeader>
            <DialogTitle>
              {isEditMode
                ? t('common:skills.update_modal_title')
                : t('common:skills.upload_modal_title')}
            </DialogTitle>
            <DialogDescription asChild>
              <div>
                <p>
                  {isEditMode
                    ? t('common:skills.update_modal_description')
                    : t('common:skills.upload_modal_description')}
                </p>

                <div className="mt-2 text-xs text-text-muted">
                  <strong>Expected ZIP structure:</strong>
                  <div className="font-mono bg-muted p-2 rounded mt-1">
                    my-skill.zip
                    <br />
                    └── my-skill/
                    <br />
                    &nbsp;&nbsp;&nbsp;&nbsp;├── SKILL.md
                    <br />
                    &nbsp;&nbsp;&nbsp;&nbsp;└── resources/
                  </div>
                  <div className="mt-2">
                    <a
                      href="https://support.claude.com/en/articles/12512198-how-to-create-custom-skills"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-link hover:underline"
                    >
                      Learn how to create custom skills →
                    </a>
                  </div>
                </div>
              </div>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {/* Skill Name Input (only for create mode) */}
            {!isEditMode && (
              <div className="space-y-2">
                <Label htmlFor="skill-name">{t('common:skills.skill_name_required')}</Label>
                <Input
                  id="skill-name"
                  placeholder={t('common:skills.skill_name_placeholder')}
                  value={skillName}
                  onChange={e => setSkillName(e.target.value)}
                  disabled={uploading}
                />
                <p className="text-xs text-text-muted">{t('common:skills.skill_name_hint')}</p>
              </div>
            )}

            {/* File Upload Area */}
            <div className="space-y-2">
              <Label>{t('common:skills.zip_package_required')}</Label>
              <div
                className={`
                  relative border-2 border-dashed rounded-lg p-6 text-center transition-colors
                  ${dragActive ? 'border-primary bg-primary/5' : 'border-border'}
                  ${uploading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:border-primary/50'}
                `}
                onDragEnter={handleDrag}
                onDragLeave={handleDrag}
                onDragOver={handleDrag}
                onDrop={handleDrop}
                onClick={() => !uploading && document.getElementById('file-input')?.click()}
              >
                <input
                  id="file-input"
                  type="file"
                  accept=".zip"
                  onChange={handleFileChange}
                  className="hidden"
                  disabled={uploading}
                />

                {selectedFile ? (
                  <div className="flex items-center justify-center gap-2">
                    <FileIcon className="w-5 h-5 text-primary" />
                    <span className="text-sm text-text-primary">{selectedFile.name}</span>
                    <span className="text-xs text-text-muted">
                      ({(selectedFile.size / (1024 * 1024)).toFixed(2)} MB)
                    </span>
                  </div>
                ) : (
                  <div>
                    <UploadIcon className="w-8 h-8 mx-auto text-text-muted mb-2" />
                    <p className="text-sm text-text-primary mb-1">
                      {t('common:skills.drop_file_here')}
                    </p>
                    <p className="text-xs text-text-muted">{t('common:skills.max_file_size')}</p>
                  </div>
                )}
              </div>
            </div>

            {/* Upload Progress */}
            {uploading && (
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-text-secondary">{t('common:skills.upload_progress')}</span>
                  <span className="text-text-secondary">{uploadProgress}%</span>
                </div>
                <Progress value={uploadProgress} />
              </div>
            )}

            {/* Error Message */}
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {/* Requirements Info */}
            <Alert>
              <AlertDescription className="text-xs">
                <strong>{t('common:skills.requirements')}</strong>
                <ul className="list-disc list-inside mt-1 space-y-0.5">
                  <li>{t('common:skills.requirement_zip')}</li>
                  <li>{t('common:skills.requirement_structure')}</li>
                  <li>{t('common:skills.requirement_folder_name')}</li>
                  <li>{t('common:skills.requirement_description')}</li>
                  <li>{t('common:skills.requirement_optional')}</li>
                  <li>{t('common:skills.requirement_size')}</li>
                </ul>
              </AlertDescription>
            </Alert>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={handleClose} disabled={uploading}>
              {t('common:actions.cancel')}
            </Button>
            <Button onClick={handleSubmit} disabled={uploading || !selectedFile}>
              {uploading
                ? t('common:skills.uploading')
                : isEditMode
                  ? t('common:skills.update_skill')
                  : t('common:actions.upload')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Overwrite Confirmation Dialog */}
      <AlertDialog open={overwriteDialogOpen} onOpenChange={setOverwriteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('common:skills.overwrite_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('common:skills.overwrite_confirm_message', { name: skillName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleOverwriteCancel}>
              {t('common:actions.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleOverwriteConfirm}>
              {t('common:skills.overwrite_confirm_button')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
