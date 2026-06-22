import { ApiError } from '@/api/http'

export const ADMIN_PASSWORD_SETUP_REQUIRED_ERROR_CODE = 'ADMIN_PASSWORD_SETUP_REQUIRED'
export const INITIAL_ADMIN_USERNAME = 'admin'

export function isAdminPasswordSetupRequiredError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.errorCode === ADMIN_PASSWORD_SETUP_REQUIRED_ERROR_CODE
}

export function getAdminUsernameFromSetupError(error: ApiError): string {
  const detail = error.detail
  if (detail && typeof detail === 'object') {
    const adminUsername = (detail as { admin_username?: unknown }).admin_username
    if (typeof adminUsername === 'string' && adminUsername) {
      return adminUsername
    }
  }
  return INITIAL_ADMIN_USERNAME
}
