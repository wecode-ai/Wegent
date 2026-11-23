import { elementOf } from '@ui-sdk/core/observe'
import { createAgent } from '@ui-sdk/react/agent'
import { waitForDomChange } from './waitForDomChange'
export type DesktopControlSelectMode = 'label' | 'value'

export function chooseDesktopControlOption(element: HTMLElement, selection: string): string {
  if (element instanceof HTMLSelectElement) {
    return selectDesktopControlOption(element, selection)
  }
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error('Choice target must be a select or button element')
  }
  element.click()
  return element.textContent?.trim() ?? ''
}

export function selectDesktopControlOption(
  element: HTMLSelectElement,
  selection: string,
  mode: DesktopControlSelectMode = 'value'
): string {
  const option = Array.from(element.options).find(candidate =>
    mode === 'label' ? candidate.label.trim() === selection.trim() : candidate.value === selection
  )
  if (element.matches(':disabled')) throw new Error('Selection target is disabled')
  if (
    option?.disabled ||
    (option?.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled)
  )
    throw new Error('Select option is disabled')
  if (!option) {
    throw new Error(`Unable to find select option by ${mode} "${selection}"`)
  }

  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  setter?.call(element, option.value)
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
  return option.label.trim()
}

const selectionAgent = createAgent()

async function registeredSelection(element: HTMLElement) {
  const candidates = (
    await Promise.all(['select', 'combobox'].map(kind => selectionAgent.query({ kind })))
  ).flatMap(result => ('error' in result ? [] : result))
  const bindings = candidates
    .filter(candidate => !candidate.offPage && ['select', 'combobox'].includes(candidate.component))
    .map(candidate => ({ candidate, bound: elementOf(candidate.ref) }))
  const exact = bindings.find(({ bound }) => bound === element)
  if (exact) return exact.candidate
  const labels = element.getAttribute('aria-labelledby')?.split(/\s+/) ?? []
  const labelled = bindings.find(({ bound }) => bound?.id && labels.includes(bound.id))
  if (labelled) return labelled.candidate
  const owned = bindings.filter(({ bound }) => bound?.contains(element) || element.contains(bound))
  return owned.length === 1 ? owned[0].candidate : undefined
}

function selectionValue(element: HTMLElement, ref: string): unknown {
  if (element instanceof HTMLSelectElement) return element.value
  const declared =
    element.getAttribute('data-value') ?? element.firstElementChild?.getAttribute('data-value')
  if (declared != null) return declared
  return selectionAgent.snapshot().find(candidate => candidate.ref === ref)?.value
}

export async function desktopControlSelectionValue(
  element: HTMLElement
): Promise<string | undefined> {
  if (element instanceof HTMLSelectElement) return element.value
  const target = await registeredSelection(element)
  if (!target) return undefined
  const value = selectionValue(element, target.ref)
  if (typeof value === 'string') return value
  if (value === null) return ''
  throw new Error('Selection target does not expose a scalar value')
}

async function waitForSelection(
  element: HTMLElement,
  ref: string,
  expected: string,
  timeoutMs: number
) {
  if (selectionValue(element, ref) === expected) return
  await new Promise<void>((resolve, reject) => {
    let finished = false
    let frame = 0
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      cancelAnimationFrame(frame)
      observer.disconnect()
      if (error) reject(error)
      else resolve()
    }
    const check = () => {
      if (finished) return
      if (element.isConnected && selectionValue(element, ref) === expected) finish()
      else {
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(check)
      }
    }
    const observer = new MutationObserver(check)
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `Selection was not accepted: expected "${expected}", actual "${String(selectionValue(element, ref))}"`
          )
        ),
      timeoutMs
    )
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    })
    check()
  })
}

export async function selectDesktopControlChoice(
  element: HTMLElement,
  selection: string,
  mode: DesktopControlSelectMode = 'value',
  timeoutMs = 1000
): Promise<string> {
  if (!element.isConnected) throw new Error('Selection target is no longer mounted')
  if (!desktopControlElementEnabled(element)) throw new Error('Selection target is disabled')
  if (element instanceof HTMLSelectElement) {
    const expected =
      Array.from(element.options).find(option =>
        mode === 'label' ? option.label.trim() === selection.trim() : option.value === selection
      )?.value ?? selection
    const label = selectDesktopControlOption(element, selection, mode)
    await waitForSelection(element, '', expected, timeoutMs)
    return label
  }
  const target = await registeredSelection(element)
  if (!target) throw new Error('Selection target is not a registered SDK select or combobox')
  if (target.disabled || !target.actions.includes('setValue'))
    throw new Error('Selection target is disabled or read-only')
  // The agent omits empty item keys. Use the owned listbox to select a declared empty value.
  if (target.component === 'select' && mode === 'value' && selection === '') {
    if (element.getAttribute('aria-expanded') !== 'true') {
      const opened = await selectionAgent.act({
        steps: [{ ref: target.ref, action: 'setOpen', args: [true] }],
      })
      if (!opened.ok) throw new Error(opened.error?.message ?? 'Unable to open selection target')
    }
    const contentId = element.getAttribute('aria-controls')
    const option = (
      contentId ? element.ownerDocument.getElementById(contentId) : null
    )?.querySelector<HTMLElement>('[role="option"][data-value=""]')
    if (!option) throw new Error('Unable to find select option by value ""')
    if (option.matches('[aria-disabled="true"], [data-disabled]'))
      throw new Error('Select option is disabled')
    option.click()
    await waitForSelection(element, target.ref, '', timeoutMs)
    return option.textContent?.trim() ?? ''
  }
  const findOption = async () => {
    const found = await selectionAgent.query({ within: target.ref, text: selection })
    if ('error' in found) throw new Error(found.error)
    return found[0]?.items?.find(item =>
      mode === 'label' ? item.label.trim() === selection.trim() : item.value === selection
    )
  }
  const deadline = performance.now() + timeoutMs
  let option = await findOption()
  if (!option && target.actions.includes('setOpen')) {
    if (element.getAttribute('aria-expanded') !== 'true') {
      const opened = await selectionAgent.act({
        steps: [{ ref: target.ref, action: 'setOpen', args: [true] }],
      })
      if (!opened.ok) throw new Error(opened.error?.message ?? 'Unable to open selection target')
    }
    while (!option && element.isConnected && performance.now() < deadline) {
      option = await findOption()
      if (!option) await waitForDomChange(element.ownerDocument.documentElement)
    }
  }
  if (!option) throw new Error(`Unable to find select option by ${mode} "${selection}"`)
  const result = await selectionAgent.act({
    steps: [{ ref: target.ref, action: 'setValue', args: [option.value] }],
  })
  if (!result.ok) throw new Error(result.error?.message ?? 'Unable to select option')
  await waitForSelection(element, target.ref, option.value, timeoutMs)
  return option.label.trim()
}

export function desktopControlElementEnabled(element: HTMLElement): boolean {
  return !element.matches(':disabled, [aria-disabled="true"]') && !element.closest('[inert]')
}

export async function chooseDesktopControlChoice(
  element: HTMLElement,
  selection: string,
  timeoutMs = 1000
): Promise<string> {
  if (element instanceof HTMLSelectElement || (await registeredSelection(element)))
    return selectDesktopControlChoice(element, selection, 'value', timeoutMs)
  if (!desktopControlElementEnabled(element)) throw new Error('Choice target is disabled')
  return chooseDesktopControlOption(element, selection)
}
