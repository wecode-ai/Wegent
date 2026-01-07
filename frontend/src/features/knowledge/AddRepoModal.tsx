// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import Modal from '@/features/common/Modal'
import { GitRepoInfo } from '@/types/api'
import { useUser } from '@/features/common/UserContext'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { paths } from '@/config/paths'
import { useTranslation } from '@/hooks/useTranslation'
import { RepositorySelector } from '@/features/tasks/components/selector'
import { WikiConfigResponse } from '@/apis/wiki'

interface AddRepoModalProps {
  isOpen: boolean
  onClose: () => void
  formErrors: Record<string, string>
  isSubmitting: boolean
  onRepoChange: (repo: GitRepoInfo | null) => void
  onSubmit: (e: React.FormEvent) => void
  selectedRepo: GitRepoInfo | null
  // Wiki config (system-level configuration)
  wikiConfig: WikiConfigResponse | null
}

export default function AddRepoModal({
  isOpen,
  onClose,
  formErrors,
  isSubmitting,
  onRepoChange,
  onSubmit,
  selectedRepo,
  wikiConfig,
}: AddRepoModalProps) {
  const { t } = useTranslation()
  const { user } = useUser()
  const router = useRouter()

  const hasGitInfo = () => {
    return user && user.git_info && user.git_info.length > 0
  }

  const handleGoToSettings = () => {
    onClose()
    router.push(paths.settings.integrations.getHref())
  }

  // Check if user has git info configured
  if (!hasGitInfo()) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title={t('knowledge:add_repository')} maxWidth="md">
        <div className="flex flex-col items-center py-8">
          <p className="text-sm text-text-secondary mb-6 text-center leading-relaxed">
            {t('common:guide.description')}
          </p>
          <Button variant="default" size="sm" onClick={handleGoToSettings}>
            {t('common:branches.set_token')}
          </Button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('knowledge:add_repository')} maxWidth="md">
      <form onSubmit={onSubmit} className="space-y-5">
        {formErrors.submit && <div className="text-red-500 text-sm mb-4">{formErrors.submit}</div>}

        {/* Show warning if no bound model */}
        {wikiConfig && !wikiConfig.has_bound_model && (
          <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 px-4 py-3 rounded-md text-sm">
            {t('knowledge:no_bound_model_warning')}
          </div>
        )}

        {/* Repository Selector */}
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-2">
            {t('knowledge:repository')}
          </label>
          <div className="px-3 py-2 border border-border rounded-md bg-base">
            <RepositorySelector
              selectedRepo={selectedRepo}
              handleRepoChange={onRepoChange}
              disabled={isSubmitting || (wikiConfig !== null && !wikiConfig.has_bound_model)}
              fullWidth
            />
          </div>
          {formErrors.source_url && (
            <p className="mt-1 text-sm text-red-500">{formErrors.source_url}</p>
          )}
        </div>

        <div className="flex justify-end space-x-3 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-text-primary bg-surface border border-border rounded-md hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary/40"
            disabled={isSubmitting}
          >
            {t('common:actions.cancel')}
          </button>
          <button
            type="submit"
            className="px-4 py-2 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary-hover focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
            disabled={
              isSubmitting || !selectedRepo || (wikiConfig !== null && !wikiConfig.has_bound_model)
            }
          >
            {isSubmitting ? (
              <div className="flex items-center">
                <svg
                  className="animate-spin -ml-1 mr-2 h-4 w-4 text-white"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  ></circle>
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
                {t('knowledge:adding')}
              </div>
            ) : (
              t('knowledge:add_repository')
            )}
          </button>
        </div>
      </form>
    </Modal>
  )
}
