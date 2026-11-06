import assert from 'node:assert/strict'

export function pluginOperationNetworkRequests(requests, timeOrigin, admission) {
  assert.ok(Number.isFinite(timeOrigin) && timeOrigin > 0, 'Renderer clock is unavailable')
  assert.ok(Number.isFinite(admission?.capturedAt), 'Import admission was not observed')
  assert.equal(admission.deliveries, 1, 'The observed import request must execute once')
  // Proxy events use integer Date.now() timestamps; round down conservatively
  // so a request in the same millisecond as admission cannot escape the check.
  const operationAdmittedAt = Math.floor(timeOrigin + admission.capturedAt)
  return {
    operationAdmittedAt,
    requests: requests.filter(request => request.receivedAt >= operationAdmittedAt),
  }
}
