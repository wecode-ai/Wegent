/** Insert at the live editor selection, including selections spanning existing mentions. */
export function insertComposerReference(
  snapshot: { value: string; selectionStart: number; selectionEnd: number },
  reference: string
) {
  const before = snapshot.value.slice(0, snapshot.selectionStart)
  const after = snapshot.value.slice(snapshot.selectionEnd)
  const suffix = /(?:^|\s)[@#]$/.test(reference) ? '' : ' '
  const inserted = `${before && !/\s$/.test(before) ? ' ' : ''}${reference}${suffix}`
  return { value: `${before}${inserted}${after}`, cursor: before.length + inserted.length }
}
