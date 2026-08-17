export function withPublishedPluginCloudLink(
  sourcePayload: Record<string, unknown> | null | undefined,
  cloudPluginId: number,
  cloudReleaseId: number | null
): Record<string, unknown> {
  return {
    ...(sourcePayload ?? {}),
    cloudPluginId,
    cloudReleaseId,
  }
}
