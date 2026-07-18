export interface RuntimeApprovalPayload {
  kind: 'approval'
  method?: string
  reason?: string | null
  command?: string | null
  cwd?: string | null
  grantRoot?: string | null
  itemId?: string
  proposedExecpolicyAmendment?: { command?: string[] } | null
  proposedNetworkPolicyAmendments?: Array<{ host: string; action: string }> | null
  permissions?: Record<string, unknown>
}

export function isRuntimeApprovalPayload(value: unknown): value is RuntimeApprovalPayload {
  return Boolean(
    value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'approval'
  )
}
