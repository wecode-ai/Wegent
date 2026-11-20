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
  mode: DesktopControlSelectMode = 'value',
  includeOptionsOnError = false
): string {
  const option = Array.from(element.options).find(candidate =>
    mode === 'label' ? candidate.label.trim() === selection.trim() : candidate.value === selection
  )
  if (!option) {
    const diagnostics = includeOptionsOnError
      ? `; select=${JSON.stringify({
          selectedValue: element.value,
          selectedLabel: element.selectedOptions[0]?.label.trim() ?? null,
          options: Array.from(element.options, candidate => ({
            value: candidate.value,
            label: candidate.label.trim(),
            disabled: candidate.disabled,
          })),
        })}`
      : ''
    throw new Error(`Unable to find select option by ${mode} "${selection}"${diagnostics}`)
  }

  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  setter?.call(element, option.value)
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
  return option.label.trim()
}
