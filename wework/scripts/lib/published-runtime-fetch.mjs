export class PublishedRuntimeUnavailableError extends Error {}

function isTransientStatus(status) {
  return status === 408 || status === 429 || status >= 500
}

export async function fetchPublishedResource(url, fetchImpl = fetch) {
  let response
  try {
    response = await fetchImpl(url)
  } catch (error) {
    throw new PublishedRuntimeUnavailableError('Published runtime is unavailable', {
      cause: error,
    })
  }
  if (isTransientStatus(response.status)) {
    throw new PublishedRuntimeUnavailableError(
      `Published runtime is temporarily unavailable: ${response.status}`
    )
  }
  return response
}

export async function fetchOptionalPublishedDescriptor(
  url,
  { fetchImpl = fetch, log = console.warn } = {}
) {
  let response
  try {
    response = await fetchPublishedResource(url, fetchImpl)
  } catch (error) {
    if (!(error instanceof PublishedRuntimeUnavailableError)) throw error
    log(`${error.message}; building the runtime locally`)
    return null
  }
  return response.status === 404 ? null : response
}
