interface DeliveryResult {
  sent: boolean
  error?: string | null
  code?: string | null
  turnId?: string
}

/** Resolve only confirmed turn-boundary races; transport errors never trigger a second send. */
export async function deliverNativeConversationMessage({
  busy,
  send,
  guide,
  isBusyError,
}: {
  busy: boolean
  send(): Promise<DeliveryResult>
  guide(): Promise<DeliveryResult>
  isBusyError(error: string | null): boolean
}): Promise<DeliveryResult & { delivery: 'message' | 'guidance' }> {
  if (busy) {
    const result = await guide()
    if (result.sent || result.code !== 'no_active_turn') return { ...result, delivery: 'guidance' }
    return { ...(await send()), delivery: 'message' }
  }
  const result = await send()
  if (result.sent || !isBusyError(result.error ?? null)) return { ...result, delivery: 'message' }
  return { ...(await guide()), delivery: 'guidance' }
}
