let connectorSyncRevision = Date.now() * 1_000

export function nextConnectorSyncRevision() {
  connectorSyncRevision = Math.max(connectorSyncRevision + 1, Date.now() * 1_000)
  return connectorSyncRevision
}
