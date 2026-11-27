/** The real marketplace scrolling widget owns detail-return position and filter resets. */
export function createPluginMarketplaceViewport() {
  let node: HTMLDivElement | null = null
  let filterKey: string | undefined
  let saved: number | null = null
  let frame: number | undefined
  return {
    remember() {
      saved = node?.scrollTop ?? 0
    },
    attach(element: HTMLDivElement, key: string) {
      node = element
      if (filterKey !== key) {
        filterKey = key
        saved = null
        element.scrollTop = 0
      }
      if (saved !== null)
        frame = window.requestAnimationFrame(() => {
          if (node !== element || !element.isConnected || saved === null) return
          element.scrollTop = saved
          saved = null
          frame = undefined
        })
      return () => {
        if (node !== element) return
        node = null
        if (frame !== undefined) cancelAnimationFrame(frame)
        frame = undefined
      }
    },
  }
}
