export function monitoringMetadata(platform, value, { fingerprint, invalid }) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length < 1 || value.length > 100)
    throw invalid('Select between 1 and 100 issue or change-request references')
  const unique = new Map()
  for (const object of value) {
    if (
      !object ||
      typeof object !== 'object' ||
      Array.isArray(object) ||
      Object.keys(object).some(key => !['entityKind', 'number'].includes(key)) ||
      !['issue', 'change_request'].includes(object.entityKind) ||
      !Number.isSafeInteger(object.number) ||
      object.number < 1
    )
      throw invalid('Select a valid issue or change-request reference')
    unique.set(`${object.entityKind}:${object.number}`, {
      entityKind: object.entityKind,
      number: object.number,
    })
  }
  const monitoredObjects = [...unique.values()].sort(
    (a, b) => a.entityKind.localeCompare(b.entityKind) || a.number - b.number
  )
  const groups = ['change_request', 'issue'].flatMap(kind => {
    const numbers = monitoredObjects
      .filter(object => object.entityKind === kind)
      .map(
        object => (platform === 'gitlab' && kind === 'change_request' ? '!' : '#') + object.number
      )
    return numbers.length
      ? [
          (kind === 'issue' ? 'Issues ' : platform === 'github' ? 'PRs ' : 'MRs ') +
            numbers.join(', '),
        ]
      : []
  })
  return {
    monitoredObjects,
    collectionKey: 'git-monitor:v1:' + fingerprint(monitoredObjects),
    configurationSummary: groups.join('; '),
  }
}

export function validateMonitoringSource(platform, source, helpers) {
  const metadata = monitoringMetadata(platform, source.monitoredObjects, helpers)
  if (!metadata) {
    if (source.collectionKey !== undefined || source.configurationSummary !== undefined)
      throw helpers.invalid('Monitoring metadata requires an explicit object selection')
    return undefined
  }
  if (
    source.kind !== 'repository' ||
    source.transport !== 'cli' ||
    source.collectionKey !== metadata.collectionKey ||
    source.configurationSummary !== metadata.configurationSummary
  )
    throw helpers.invalid('Monitoring selection metadata is not canonical')
  return metadata
}

export function monitoringCheckpoint(platform, source, metadata, { canonicalTopic, parseProfile }) {
  const { instance } = parseProfile(source.profile)
  const tracked = Object.fromEntries(
    metadata.monitoredObjects.map(object => {
      const url = canonicalTopic(platform, instance, source.name, object.entityKind, object.number)
      return [url, { ...object, repository: source.name, url, baseline: true }]
    })
  )
  return {
    after: source.enabledAfter,
    selectionSignature: metadata.collectionKey,
    seen: {},
    tracked,
    page: 1,
    trackIndex: 0,
    trackStep: 0,
  }
}
