import assert from 'node:assert/strict'

export async function fetchGithubReleaseAsset({
  repository,
  tag,
  name,
  redirect = 'follow',
  token,
  fetchImpl = fetch,
}) {
  const base = `https://api.github.com/repos/${repository}/releases`
  const signal = AbortSignal.timeout(120_000)
  const headers = token ? { authorization: `Bearer ${token}` } : {}
  const metadata = await fetchImpl(`${base}/tags/${encodeURIComponent(tag)}`, { headers, signal })
  assert.ok(
    metadata.ok,
    `Release metadata request failed: ${repository}@${tag} HTTP ${metadata.status}`
  )
  const asset = (await metadata.json()).assets.find(item => item.name === name)
  assert.ok(Number.isSafeInteger(asset?.id) && asset.id > 0, `Release asset is missing: ${name}`)
  return fetchImpl(`${base}/assets/${asset.id}?download=1`, {
    headers: { ...headers, accept: 'application/octet-stream' },
    redirect,
    signal,
  })
}
