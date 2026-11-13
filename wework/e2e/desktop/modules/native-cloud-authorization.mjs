/** Real Backend authorization, evaluated inside the delivered Electron main process. */
export async function authorizeNativeCloud(
  credentials,
  { apiBaseUrl, authToken },
  request,
  assert
) {
  const prepared = await credentials.prepareAuthorization(apiBaseUrl)
  const created = await request(`${apiBaseUrl}/auth/wework/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_public_key: prepared.publicKey }),
  })
  assert.equal(created.ok, true, 'The real Backend must create the native authorization session')
  const authorization = await created.json()
  const approved = await request(
    `${apiBaseUrl}/auth/wework/sessions/${authorization.session_id}/approve`,
    { method: 'POST', headers: { Authorization: `Bearer ${authToken}` } }
  )
  assert.equal(approved.ok, true, 'The fixture user must approve the native session')
  const claimed = await credentials.claimAuthorization({
    authorizationId: prepared.authorizationId,
    sessionId: authorization.session_id,
    pollToken: authorization.poll_token,
  })
  assert.equal(claimed.status, 'success')
  assert.equal(claimed.credentialMode, 'desktop_refresh')
  const userResponse = await request(`${apiBaseUrl}/users/me`, {
    headers: { Authorization: `Bearer ${claimed.accessToken}` },
  })
  assert.equal(userResponse.ok, true, 'The native fixture must validate the authorized owner')
  const user = await userResponse.json()
  await credentials.commitAuthorization(prepared.authorizationId, user.id)
  const refreshed = await credentials.refreshAccessToken(apiBaseUrl, user.id)
  assert.ok(refreshed.accessToken, 'The real Backend must refresh the claimed native credential')
  return 'authorized'
}
