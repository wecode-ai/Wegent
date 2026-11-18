/** Wake element predicates on DOM updates, retaining polling for layout changes. */
export function waitForDomChange(root: Node, pollMs = 16): Promise<void> {
  return new Promise(resolve => {
    const complete = () => {
      observer.disconnect()
      clearTimeout(timer)
      resolve()
    }
    const observer = new MutationObserver(complete)
    const timer = setTimeout(complete, pollMs)
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    })
  })
}
