/** Version 2 is opt-in. Old runtimes ignore the request field and return their
 * original transcript; old clients never receive a transfer envelope. */
export async function readRuntimeTranscript<T>(
  params: Record<string, unknown>,
  request: (params: Record<string, unknown>) => Promise<unknown>
): Promise<T> {
  const query = { ...params, transcriptProtocolVersion: 2 }
  let response = await request(query)
  checkFailure(response)
  if (!isRecord(response)) throw invalidTransfer()
  if (response.transcriptProtocolVersion === undefined) return response as T
  if (response.transcriptProtocolVersion !== 2) throw new Error('Unsupported transcript protocol')

  const chunks: Uint8Array<ArrayBuffer>[] = []
  let offset = 0
  let snapshotId: string | undefined
  let totalBytes: number | undefined
  for (;;) {
    checkFailure(response)
    if (!isRecord(response) || response.transcriptProtocolVersion !== 2) throw invalidTransfer()
    const transfer = response.transfer
    if (!isRecord(transfer) || transfer.encoding !== 'gzip+base64+json') throw invalidTransfer()
    if (
      typeof transfer.snapshotId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(transfer.snapshotId) ||
      typeof transfer.totalBytes !== 'number' ||
      !Number.isSafeInteger(transfer.totalBytes) ||
      transfer.totalBytes <= 0 ||
      transfer.offset !== offset ||
      typeof transfer.payload !== 'string'
    )
      throw invalidTransfer()
    snapshotId ??= transfer.snapshotId
    totalBytes ??= transfer.totalBytes
    if (transfer.snapshotId !== snapshotId || transfer.totalBytes !== totalBytes)
      throw invalidTransfer()
    const binary = atob(transfer.payload)
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    if (!bytes.length || bytes.length > 360 * 1024) throw invalidTransfer()
    offset += bytes.length
    if (offset > totalBytes) throw invalidTransfer()
    chunks.push(bytes)
    if (transfer.nextOffset === null) {
      if (offset !== totalBytes) throw invalidTransfer()
      break
    }
    if (transfer.nextOffset !== offset || offset >= totalBytes) throw invalidTransfer()
    response = await request({ ...query, transcriptTransfer: { snapshotId, offset } })
  }
  // Gzip verifies the checksum before the complete page is exposed to callers.
  const stream = new ReadableStream<BufferSource>({
    start(controller) {
      chunks.forEach(chunk => controller.enqueue(chunk))
      controller.close()
    },
  }).pipeThrough(new DecompressionStream('gzip'))
  const packed: unknown = JSON.parse(await new Response(stream).text())
  return unpackTranscript(packed) as T
}

function unpackTranscript(packed: unknown): unknown {
  if (
    !isRecord(packed) ||
    !isRecord(packed.transcript) ||
    !Array.isArray(packed.strings) ||
    !packed.strings.every(value => typeof value === 'string') ||
    !Array.isArray(packed.references)
  )
    throw invalidTransfer()
  for (const reference of packed.references) {
    if (
      !isRecord(reference) ||
      !Array.isArray(reference.path) ||
      !reference.path.length ||
      !Number.isSafeInteger(reference.index) ||
      typeof reference.index !== 'number' ||
      reference.index < 0 ||
      reference.index >= packed.strings.length
    )
      throw invalidTransfer()
    let target: unknown = packed.transcript
    for (let index = 0; index < reference.path.length; index++) {
      const key: unknown = reference.path[index]
      if (
        (typeof key !== 'string' && typeof key !== 'number') ||
        target === null ||
        typeof target !== 'object' ||
        !Object.prototype.hasOwnProperty.call(target, key)
      )
        throw invalidTransfer()
      const object = target as Record<string | number, unknown>
      if (index === reference.path.length - 1) {
        if (object[key] !== null) throw invalidTransfer()
        // Define an own data property, including for user-controlled JSON keys.
        Object.defineProperty(object, key, {
          value: packed.strings[reference.index],
          enumerable: true,
          writable: true,
          configurable: true,
        })
      } else target = object[key]
    }
  }
  checkFailure(packed.transcript)
  return packed.transcript
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function checkFailure(value: unknown): void {
  if (!isRecord(value) || value.success !== false) return
  if (
    value.code === 'runtime_rpc_response_too_large' ||
    value.code === 'app_ipc_response_too_large'
  ) {
    throw new Error(
      'History exceeds this Executor version’s transfer limit. Upgrade the Executor and retry.'
    )
  }
  throw new Error(typeof value.error === 'string' ? value.error : 'Transcript transfer failed')
}

function invalidTransfer(): Error {
  return new Error('Invalid or incomplete transcript transfer; reload history')
}
