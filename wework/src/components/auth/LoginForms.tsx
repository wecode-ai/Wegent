import { Eye, EyeOff } from 'lucide-react'
import { useState } from 'react'
import type { FormEvent } from 'react'
import type { LoginRequest } from '@/api/auth'
import { useTranslation } from '@/hooks/useTranslation'

export const OUTLINED_LOGIN_BUTTON_CLASS =
  'h-11 w-full rounded-lg border border-border bg-background text-sm font-semibold text-text-primary hover:bg-muted'

interface PasswordLoginFormTestIds {
  form?: string
  usernameInput?: string
  passwordInput?: string
  togglePasswordButton?: string
  submitButton?: string
  error?: string
}

interface PasswordLoginFormLabels {
  username?: string
  password?: string
  submit?: string
  submitting?: string
  togglePassword?: string
}

interface PasswordLoginFormProps {
  value: LoginRequest
  error?: string | null
  submitting?: boolean
  labels?: PasswordLoginFormLabels
  testIds?: PasswordLoginFormTestIds
  onChange: (value: LoginRequest) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}

interface AdminPasswordSetupFormTestIds {
  form?: string
  usernameSummary?: string
  usernameValue?: string
  passwordInput?: string
  confirmPasswordInput?: string
  passwordVisibilityButton?: string
  confirmPasswordVisibilityButton?: string
  submitButton?: string
  error?: string
}

interface AdminPasswordSetupFormLabels {
  title?: string
  description?: string
  usernameLabel?: string
  usernameDescription?: string
  password?: string
  passwordPlaceholder?: string
  confirmPassword?: string
  confirmPasswordPlaceholder?: string
  submit?: string
  submitting?: string
  togglePassword?: string
}

interface AdminPasswordSetupFormProps {
  adminUsername: string
  value: {
    password: string
    confirmPassword: string
  }
  error?: string | null
  submitting?: boolean
  labels?: AdminPasswordSetupFormLabels
  testIds?: AdminPasswordSetupFormTestIds
  onChange: (value: { password: string; confirmPassword: string }) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}

export function PasswordLoginForm({
  value,
  error,
  submitting = false,
  labels,
  testIds,
  onChange,
  onSubmit,
}: PasswordLoginFormProps) {
  const { t } = useTranslation('common')
  const [showPassword, setShowPassword] = useState(false)

  const resolvedTestIds = {
    form: 'login-form',
    usernameInput: 'login-username-input',
    passwordInput: 'login-password-input',
    togglePasswordButton: 'toggle-password-visibility-button',
    submitButton: 'login-submit-button',
    error: 'login-error',
    ...testIds,
  }

  return (
    <form data-testid={resolvedTestIds.form} className="space-y-5" onSubmit={onSubmit}>
      <div>
        <label
          htmlFor={resolvedTestIds.usernameInput}
          className="text-sm font-medium text-text-secondary"
        >
          {labels?.username ?? t('workbench.login_username')}
        </label>
        <input
          id={resolvedTestIds.usernameInput}
          name="user_name"
          data-testid={resolvedTestIds.usernameInput}
          className="mt-2 h-11 w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none focus:border-text-secondary"
          value={value.user_name}
          autoComplete="username"
          onChange={event => onChange({ ...value, user_name: event.target.value })}
        />
      </div>
      <div>
        <label
          htmlFor={resolvedTestIds.passwordInput}
          className="text-sm font-medium text-text-secondary"
        >
          {labels?.password ?? t('workbench.login_password')}
        </label>
        <div className="relative mt-2">
          <input
            id={resolvedTestIds.passwordInput}
            name="password"
            data-testid={resolvedTestIds.passwordInput}
            type={showPassword ? 'text' : 'password'}
            className="h-11 w-full rounded-lg border border-border bg-background px-3 pr-11 text-sm text-text-primary outline-none focus:border-text-secondary"
            value={value.password}
            autoComplete="current-password"
            onChange={event => onChange({ ...value, password: event.target.value })}
          />
          <button
            type="button"
            data-testid={resolvedTestIds.togglePasswordButton}
            className="absolute inset-y-0 right-0 flex h-11 w-11 items-center justify-center text-text-muted"
            onClick={() => setShowPassword(current => !current)}
            aria-label={labels?.togglePassword ?? t('workbench.toggle_password_visibility')}
          >
            {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
          </button>
        </div>
      </div>
      {error && (
        <div className="text-sm text-red-600" data-testid={resolvedTestIds.error}>
          {error}
        </div>
      )}
      <button
        type="submit"
        data-testid={resolvedTestIds.submitButton}
        className={`${OUTLINED_LOGIN_BUTTON_CLASS} disabled:opacity-60`}
        disabled={submitting}
      >
        {submitting
          ? (labels?.submitting ?? t('workbench.logging_in'))
          : (labels?.submit ?? t('workbench.login_action'))}
      </button>
    </form>
  )
}

export function AdminPasswordSetupForm({
  adminUsername,
  value,
  error,
  submitting = false,
  labels,
  testIds,
  onChange,
  onSubmit,
}: AdminPasswordSetupFormProps) {
  const { t } = useTranslation('common')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)

  const resolvedTestIds = {
    form: 'admin-password-setup-form',
    usernameSummary: 'admin-username-summary',
    usernameValue: 'admin-username-value',
    passwordInput: 'admin-password-input',
    confirmPasswordInput: 'admin-password-confirm-input',
    passwordVisibilityButton: 'admin-password-visibility-button',
    confirmPasswordVisibilityButton: 'admin-password-confirm-visibility-button',
    submitButton: 'admin-password-submit-button',
    error: 'admin-password-error',
    ...testIds,
  }

  return (
    <form data-testid={resolvedTestIds.form} className="space-y-5" onSubmit={onSubmit}>
      <div>
        <h2 className="text-lg font-semibold text-text-primary">
          {labels?.title ?? t('workbench.admin_password_setup_title')}
        </h2>
        <p className="mt-2 text-sm text-text-muted">
          {labels?.description ?? t('workbench.admin_password_setup_description')}
        </p>
      </div>
      <div
        className="rounded-lg border border-border bg-background px-4 py-3"
        data-testid={resolvedTestIds.usernameSummary}
      >
        <div className="text-xs font-medium text-text-muted">
          {labels?.usernameLabel ?? t('workbench.admin_username_label')}
        </div>
        <div
          className="mt-1 font-mono text-sm font-semibold text-text-primary"
          data-testid={resolvedTestIds.usernameValue}
        >
          {adminUsername}
        </div>
        <p className="mt-1 text-xs text-text-muted">
          {labels?.usernameDescription ?? t('workbench.admin_username_description')}
        </p>
      </div>
      <div>
        <label
          htmlFor={resolvedTestIds.passwordInput}
          className="text-sm font-medium text-text-secondary"
        >
          {labels?.password ?? t('workbench.admin_password')}
        </label>
        <div className="relative mt-2">
          <input
            id={resolvedTestIds.passwordInput}
            name="admin-password"
            data-testid={resolvedTestIds.passwordInput}
            type={showPassword ? 'text' : 'password'}
            className="h-11 w-full rounded-lg border border-border bg-background px-3 pr-11 text-sm text-text-primary outline-none focus:border-text-secondary"
            value={value.password}
            minLength={6}
            required
            autoComplete="new-password"
            placeholder={labels?.passwordPlaceholder ?? t('workbench.admin_password_placeholder')}
            onChange={event => onChange({ ...value, password: event.target.value })}
          />
          <button
            type="button"
            data-testid={resolvedTestIds.passwordVisibilityButton}
            className="absolute inset-y-0 right-0 flex h-11 w-11 items-center justify-center text-text-muted"
            onClick={() => setShowPassword(current => !current)}
            aria-label={labels?.togglePassword ?? t('workbench.toggle_admin_password_visibility')}
          >
            {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
          </button>
        </div>
      </div>
      <div>
        <label
          htmlFor={resolvedTestIds.confirmPasswordInput}
          className="text-sm font-medium text-text-secondary"
        >
          {labels?.confirmPassword ?? t('workbench.admin_password_confirm')}
        </label>
        <div className="relative mt-2">
          <input
            id={resolvedTestIds.confirmPasswordInput}
            name="admin-password-confirm"
            data-testid={resolvedTestIds.confirmPasswordInput}
            type={showConfirmPassword ? 'text' : 'password'}
            className="h-11 w-full rounded-lg border border-border bg-background px-3 pr-11 text-sm text-text-primary outline-none focus:border-text-secondary"
            value={value.confirmPassword}
            minLength={6}
            required
            autoComplete="new-password"
            placeholder={
              labels?.confirmPasswordPlaceholder ??
              t('workbench.admin_password_confirm_placeholder')
            }
            onChange={event => onChange({ ...value, confirmPassword: event.target.value })}
          />
          <button
            type="button"
            data-testid={resolvedTestIds.confirmPasswordVisibilityButton}
            className="absolute inset-y-0 right-0 flex h-11 w-11 items-center justify-center text-text-muted"
            onClick={() => setShowConfirmPassword(current => !current)}
            aria-label={labels?.togglePassword ?? t('workbench.toggle_admin_password_visibility')}
          >
            {showConfirmPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
          </button>
        </div>
      </div>
      {error && (
        <div className="text-sm text-red-600" data-testid={resolvedTestIds.error}>
          {error}
        </div>
      )}
      <button
        type="submit"
        data-testid={resolvedTestIds.submitButton}
        className={`${OUTLINED_LOGIN_BUTTON_CLASS} disabled:opacity-60`}
        disabled={submitting}
      >
        {submitting
          ? (labels?.submitting ?? t('workbench.admin_password_setting'))
          : (labels?.submit ?? t('workbench.admin_password_submit'))}
      </button>
    </form>
  )
}
