import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'

/** Persist pending-work failures through the existing redacted runtime diagnostic channel. */
export function logInteractionLoadFailure(
  operation: 'local-identity' | 'inventory' | 'transcript' | 'archive',
  error: unknown,
  context: { deviceId?: string; taskId?: string } = {}
): void {
  // Select diagnostic fields only; never serialize requests or conversation contents.
  const details = error instanceof Error ? error : null
  const metadata = error && typeof error === 'object' ? error : null
  logRuntimeTaskCreateStage('pending-interaction-load-failed', {
    operation,
    ...context,
    error: {
      name: details?.name,
      message:
        details?.message ??
        (typeof error === 'string'
          ? error
          : metadata && 'message' in metadata && typeof metadata.message === 'string'
            ? metadata.message
            : 'Unknown error'),
      stack: details?.stack,
      code: metadata && 'code' in metadata ? String(metadata.code) : undefined,
      status: metadata && 'status' in metadata ? String(metadata.status) : undefined,
      cause: details?.cause instanceof Error ? details.cause.message : undefined,
    },
  })
}
