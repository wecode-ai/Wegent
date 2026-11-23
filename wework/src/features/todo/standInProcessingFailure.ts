import { LOCAL_USER } from '@/api/local/localSession'
import type { StandInProcessingStatus } from '@/api/standIn'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import type { TFunction } from 'i18next'

export function standInProcessingFailure(
  status: StandInProcessingStatus | null,
  requestError: string | null,
  userId: number,
  t: TFunction<'common'>
) {
  const failure = status?.error
  // Older Executors persist the owner check as a generic permission error.
  const ownerMismatch =
    failure?.code === 'permission_denied' &&
    failure.message === 'The requested owner must match the connected account'
  if (ownerMismatch) {
    return {
      summary: t('standIn.processing.owner_mismatch_summary'),
      message: t(
        userId === LOCAL_USER.id
          ? 'standIn.processing.local_owner_mismatch'
          : 'standIn.processing.cloud_owner_mismatch'
      ),
      ownerMismatch,
    }
  }
  const message =
    requestError ??
    (failure?.code === 'model_unavailable'
      ? t('standIn.processing.background_model_unavailable')
      : failure?.code === 'coordination_recovery_required'
        ? t('runtimeCommandRecovery.notice')
        : failure
          ? getStandInErrorMessage(failure)
          : null)
  return { message, ownerMismatch }
}
