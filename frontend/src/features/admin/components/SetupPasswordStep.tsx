// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EyeIcon, EyeSlashIcon, ShieldCheckIcon } from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { userApis } from '@/apis/user'

interface SetupPasswordStepProps {
  onPasswordChanged: () => void
}

/**
 * Setup wizard step for changing the default admin password.
 * This step is mandatory and cannot be skipped.
 */
const SetupPasswordStep: React.FC<SetupPasswordStepProps> = ({ onPasswordChanged }) => {
  const { t } = useTranslation('admin')
  const { toast } = useToast()

  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    setError(null)

    // Validate password length
    if (newPassword.length < 6) {
      setError(t('setup_wizard.password_step.password_min_length'))
      return
    }

    // Validate password match
    if (newPassword !== confirmPassword) {
      setError(t('setup_wizard.password_step.password_mismatch'))
      return
    }

    setIsSubmitting(true)
    try {
      await userApis.changePassword({
        new_password: newPassword,
        confirm_password: confirmPassword,
      })
      toast({
        title: t('setup_wizard.password_step.change_password_success'),
      })
      onPasswordChanged()
    } catch (err) {
      console.error('Failed to change password:', err)
      setError(err instanceof Error ? err.message : t('setup_wizard.errors.complete_failed'))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Security notice */}
      <div className="flex items-start gap-3 p-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
        <ShieldCheckIcon className="w-6 h-6 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
        <div>
          <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-200">
            {t('setup_wizard.password_step.title')}
          </h3>
          <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
            {t('setup_wizard.password_step.description')}
          </p>
        </div>
      </div>

      {/* Password form */}
      <div className="space-y-4">
        {/* New password */}
        <div>
          <label
            htmlFor="new_password"
            className="block text-sm font-medium text-text-secondary mb-1"
          >
            {t('setup_wizard.password_step.new_password')}
          </label>
          <div className="relative">
            <Input
              id="new_password"
              type={showNewPassword ? 'text' : 'password'}
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              placeholder={t('setup_wizard.password_step.new_password')}
              className="pr-10"
              disabled={isSubmitting}
            />
            <button
              type="button"
              className="absolute inset-y-0 right-0 pr-3 flex items-center"
              onClick={() => setShowNewPassword(!showNewPassword)}
            >
              {showNewPassword ? (
                <EyeIcon className="h-5 w-5 text-text-muted hover:text-text-secondary" />
              ) : (
                <EyeSlashIcon className="h-5 w-5 text-text-muted hover:text-text-secondary" />
              )}
            </button>
          </div>
          <p className="text-xs text-text-muted mt-1">
            {t('setup_wizard.password_step.password_min_length')}
          </p>
        </div>

        {/* Confirm password */}
        <div>
          <label
            htmlFor="confirm_password"
            className="block text-sm font-medium text-text-secondary mb-1"
          >
            {t('setup_wizard.password_step.confirm_password')}
          </label>
          <div className="relative">
            <Input
              id="confirm_password"
              type={showConfirmPassword ? 'text' : 'password'}
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              placeholder={t('setup_wizard.password_step.confirm_password')}
              className="pr-10"
              disabled={isSubmitting}
            />
            <button
              type="button"
              className="absolute inset-y-0 right-0 pr-3 flex items-center"
              onClick={() => setShowConfirmPassword(!showConfirmPassword)}
            >
              {showConfirmPassword ? (
                <EyeIcon className="h-5 w-5 text-text-muted hover:text-text-secondary" />
              ) : (
                <EyeSlashIcon className="h-5 w-5 text-text-muted hover:text-text-secondary" />
              )}
            </button>
          </div>
        </div>

        {/* Error message */}
        {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}

        {/* Submit button */}
        <Button
          variant="primary"
          onClick={handleSubmit}
          disabled={isSubmitting || !newPassword || !confirmPassword}
          className="w-full"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('common.loading')}
            </>
          ) : (
            t('setup_wizard.password_step.change_password_button')
          )}
        </Button>
      </div>
    </div>
  )
}

export default SetupPasswordStep
