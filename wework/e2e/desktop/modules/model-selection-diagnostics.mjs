const MAX_MATCHES = 12
const MAX_LABEL_LENGTH = 160
const IDENTITY_PREFIXES = ['configured', 'effective', 'selected', 'rendered', 'live']
const MODEL_DETAIL_KEYS = [
  'scopeFingerprint',
  'modelScopeFingerprint',
  'selectionRevision',
  'isModelSelectionReady',
  'isModelCatalogReady',
  'hasLiveModelGetter',
  'hasLiveOptionsGetter',
  'modelSelectionCaptureFailed',
  ...IDENTITY_PREFIXES.flatMap(prefix => [
    `${prefix}ModelName`,
    `${prefix}ModelType`,
    `${prefix}ProviderId`,
    `${prefix}Fingerprint`,
  ]),
]

function boundedText(value) {
  return typeof value === 'string' ? value.slice(0, MAX_LABEL_LENGTH) : null
}

function modelDetails(source) {
  return Object.fromEntries(
    MODEL_DETAIL_KEYS.map(key => {
      const value = source?.[key]
      return [
        key,
        typeof value === 'string'
          ? boundedText(value)
          : typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
            ? value
            : null,
      ]
    })
  )
}

function elementDetails(element, includeText) {
  const attributes = element.attributes ?? {}
  return {
    ...(includeText ? { text: boundedText(element.text) } : {}),
    providerId: boundedText(attributes['data-model-provider-id']),
    activePane: boundedText(attributes['data-active-workbench-pane']),
    expanded: boundedText(attributes['aria-expanded']),
    disabled: attributes.disabled !== null && attributes.disabled !== undefined,
    rendered: element.rendered,
    visible: element.visible,
    top: element.top,
    left: element.left,
    width: element.width,
    height: element.height,
  }
}

/** Retain model identity and match geometry only; never serialize a whole debug snapshot. */
export async function logE2EModelSelection({
  control,
  context,
  composerSelector,
  modelSelectorButton,
  modelIds,
  labels,
  expectedProviderId,
  selectedModelLabel,
  selectedProviderId,
}) {
  const options = {
    value: JSON.stringify({
      includeText: true,
      attributeNames: ['data-model-provider-id', 'aria-expanded', 'disabled'],
    }),
  }
  const buttons = JSON.parse(
    await control.command('getElementMetrics', modelSelectorButton, options)
  )
  const panes = JSON.parse(
    await control.command('getElementMetrics', composerSelector || 'body', {
      value: JSON.stringify({ attributeNames: ['data-active-workbench-pane'] }),
    })
  )
  const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot'))
  console.info(
    '[desktop-e2e] Model selection observation',
    JSON.stringify({
      context: boundedText(context),
      expectedModelIds: (Array.isArray(modelIds) ? modelIds : [modelIds])
        .slice(0, MAX_MATCHES)
        .map(boundedText),
      expectedLabels: labels.slice(0, MAX_MATCHES).map(boundedText),
      expectedProviderId: boundedText(expectedProviderId),
      selectedModelLabel: boundedText(selectedModelLabel),
      selectedProviderId: boundedText(selectedProviderId),
      buttonCount: buttons.length,
      visibleButtonCount: buttons.filter(button => button.visible === true).length,
      buttons: buttons.slice(0, MAX_MATCHES).map(button => elementDetails(button, true)),
      paneCount: panes.length,
      panes: panes.slice(0, MAX_MATCHES).map(pane => elementDetails(pane, false)),
      hasWorkbenchTask: Boolean(snapshot.workbench?.currentRuntimeTask),
      hasPaneTask: Boolean(snapshot.pane?.currentRuntimeTask),
      modelSelection: modelDetails(snapshot.workbench?.composer?.modelSelection),
    })
  )
}
