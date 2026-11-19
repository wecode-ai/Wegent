import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resultDir } from './shared.mjs'
import { withProjectRenderer } from './project-create-test-utils.mjs'

const ACTIVE = '[data-workspace-tab-content][aria-hidden="false"]'
const DIALOG = '[data-testid="collaboration-project-create-dialog"]'
const MENU = '[data-testid="collaboration-project-create-collaborator-menu"]'
const SEARCH = '[data-testid="collaboration-project-create-people-search"]'
const BACKGROUND = {
  taskTab: '[data-testid="workspace-tab-select-fixed-task"]',
  home: `${ACTIVE} [data-testid="collaboration-primary-home"]`,
}

async function readAccessibilityEvidence(phase, selectors, optional = []) {
  return withProjectRenderer(async (client, target) => {
    const command = (method, params = {}) => client({ action: 'command', target, method, params })
    const { root } = await command('DOM.getDocument', { depth: 0 })
    const nodes = {}
    for (const [name, selector] of Object.entries(selectors)) {
      const { nodeId } = await command('DOM.querySelector', { nodeId: root.nodeId, selector })
      if (!nodeId && optional.includes(name)) continue
      assert.ok(nodeId, `${phase}: expected the real ${name} DOM node`)
      const { node } = await command('DOM.describeNode', { nodeId })
      nodes[name] = node.backendNodeId
    }
    const tree = await command('Accessibility.getFullAXTree')
    const exposed = Object.fromEntries(
      Object.entries(nodes).map(([name, backendDOMNodeId]) => [
        name,
        tree.nodes.find(node => node.backendDOMNodeId === backendDOMNodeId),
      ])
    )
    const observations = Object.fromEntries(
      Object.entries(exposed).map(([name, node]) => [
        name,
        node
          ? {
              backendDOMNodeId: node.backendDOMNodeId,
              ignored: node.ignored,
              role: node.role?.value,
              name: node.name?.value,
              properties: node.properties,
              ignoredReasons: node.ignoredReasons,
            }
          : null,
      ])
    )
    await writeFile(
      join(resultDir, `project-create-${phase}-ax.json`),
      JSON.stringify(observations, null, 2)
    )
    return { exposed, observations, tree }
  })
}

function assertHidden(exposed, name, phase) {
  assert.ok(
    !exposed[name] || exposed[name].ignored,
    `${phase}: ${name} was exposed in the AX tree: ${JSON.stringify(exposed[name])}`
  )
}

function assertDialog(node, name, modal) {
  assert.equal(node?.ignored, false, `${name} must remain accessible`)
  assert.equal(node.role?.value, 'dialog')
  assert.ok(node.name?.value?.trim(), `${name} must have an accessible name`)
  if (modal)
    assert.equal(node.properties?.find(property => property.name === 'modal')?.value?.value, true)
}

/** Assert Chromium's actual accessibility exposure, independently of the portal's DOM ancestry. */
export async function assertCollaboratorAccessibilityIsolation(phase, popupOpen) {
  const { exposed } = await readAccessibilityEvidence(
    `collaborator-${phase}`,
    { main: DIALOG, ...BACKGROUND, popup: MENU, search: SEARCH },
    popupOpen ? [] : ['popup', 'search']
  )
  for (const name of Object.keys(BACKGROUND)) assertHidden(exposed, name, phase)
  assertDialog(exposed.main, 'Project dialog', true)
  if (!popupOpen) for (const name of ['popup', 'search']) assertHidden(exposed, name, phase)
  else {
    assertDialog(exposed.popup, 'Collaborator dialog', false)
    assert.equal(exposed.search?.ignored, false, 'Collaborator search must be accessible')
    assert.equal(exposed.search.role?.value, 'textbox')
    assert.ok(exposed.search.name?.value?.trim())
    assert.equal(
      exposed.search.properties?.find(property => property.name === 'focusable')?.value?.value,
      true
    )
  }
}

export async function assertModelAccessibilityIsolation(phase, popupOpen) {
  const { exposed, tree } = await readAccessibilityEvidence(
    `model-${phase}`,
    { main: DIALOG, ...BACKGROUND, model: '[data-model-selector-layer="true"]' },
    popupOpen ? [] : ['model']
  )
  for (const name of Object.keys(BACKGROUND)) assertHidden(exposed, name, phase)
  if (!popupOpen) {
    assertHidden(exposed, 'model', phase)
    assertDialog(exposed.main, 'Restored project dialog', true)
    return
  }
  assertHidden(exposed, 'main', phase)
  assertDialog(exposed.model, 'Model dialog', true)
  const nodes = new Map(tree.nodes.map(node => [node.nodeId, node]))
  const accessibleControls = tree.nodes.filter(node => {
    if (node.ignored || !['button', 'radio', 'slider', 'textbox'].includes(node.role?.value))
      return false
    let parent = nodes.get(node.parentId)
    while (parent) {
      if (parent.nodeId === exposed.model.nodeId) return true
      parent = nodes.get(parent.parentId)
    }
    return false
  })
  assert.ok(accessibleControls.length > 0, 'The model dialog must expose its real controls')
}

export async function assertCollaboratorSearchLayout() {
  const metrics = await withProjectRenderer(async (client, target) => {
    const value = await client({
      action: 'command',
      target,
      method: 'Runtime.evaluate',
      params: {
        returnByValue: true,
        expression: `(() => {
          const input = document.querySelector('${SEARCH}')
          const label = input?.closest('label')
          const icon = label?.querySelector('svg')
          const popup = document.querySelector('${MENU}')
          if (!input || !label || !icon || !popup) return null
          const style = getComputedStyle(label)
          const inputStyle = getComputedStyle(input)
          return { input: input.getBoundingClientRect().toJSON(), icon: icon.getBoundingClientRect().toJSON(),
            label: label.getBoundingClientRect().toJSON(), popup: popup.getBoundingClientRect().toJSON(),
            focused: document.activeElement === input && label.matches(':focus-within'),
            outline: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth), outlineOffset: parseFloat(style.outlineOffset),
            inputOutline: inputStyle.outlineStyle, inputOutlineColor: inputStyle.outlineColor,
            inputOutlineWidth: parseFloat(inputStyle.outlineWidth), inputShadow: inputStyle.boxShadow,
            inputBorders: ['borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth'].map(key => parseFloat(inputStyle[key])) }
        })()`,
      },
    })
    return value.result?.value
  })
  assert.ok(metrics?.focused, 'The composite search must receive and display focus')
  const { input, icon, label, popup } = metrics
  assert.ok(Math.abs(icon.y + icon.height / 2 - input.y - input.height / 2) <= 2)
  assert.ok(icon.right <= input.left, 'The search icon must precede the input without overlap')
  assert.ok(icon.left >= label.left && input.right <= label.right)
  assert.equal(metrics.outline, 'solid')
  assert.ok(metrics.outlineWidth >= 2)
  // Tailwind's outline-none can leave a transparent outline for forced-colors support.
  assert.ok(
    metrics.inputOutline === 'none' ||
      metrics.inputOutlineWidth === 0 ||
      metrics.inputOutlineColor === 'rgba(0, 0, 0, 0)',
    `Only the composite search should draw focus: ${JSON.stringify(metrics)}`
  )
  assert.equal(metrics.inputShadow, 'none', 'The search input must not draw a second focus frame')
  assert.ok(
    metrics.inputBorders.every(width => width === 0),
    'Search must have one composite frame'
  )
  const ring = metrics.outlineWidth + metrics.outlineOffset
  assert.ok(
    label.left - ring >= popup.left &&
      label.right + ring <= popup.right &&
      label.top - ring >= popup.top &&
      label.bottom + ring <= popup.bottom,
    `The composite search focus outline is clipped: ${JSON.stringify(metrics)}`
  )
}
