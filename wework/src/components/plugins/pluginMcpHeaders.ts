export function buildPluginMcpHeadersUpdate(
  componentKey: string,
  headers: Record<string, string> | null
): { componentConfig: Record<string, unknown> } {
  return {
    componentConfig: {
      [componentKey]: headers && Object.keys(headers).length > 0 ? { headers } : null,
    },
  }
}
