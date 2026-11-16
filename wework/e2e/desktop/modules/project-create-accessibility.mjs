import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resultDir } from './shared.mjs'
import { withProjectRenderer } from './project-create-test-utils.mjs'

const ACTIVE = '[data-workspace-tab-content][aria-hidden="false"]'
const DIALOG = '[data-testid="collaboration-project-create-dialog"]'
const MENU = '[data-testid="collaboration-project-create-collaborator-menu"]'
const SEARCH = '[data-testid="collaboration-project-create-people-search"]'

/** Assert Chromium's actual accessibility exposure, independently of the portal's DOM ancestry. */
export async function assertCollaboratorAccessibilityIsolation(phase, popupOpen) {
  await withProjectRenderer(async (client, target) => {
    const command = (method, params = {}) => client({ action: 'command', target, method, params })
    const { root } = await command('DOM.getDocument', { depth: 0 })
    const selectors = {
      main: DIALOG,
      taskTab: '[data-testid="workspace-tab-select-fixed-task"]',
      home: `${ACTIVE} [data-testid="collaboration-primary-home"]`,
      popup: MENU,
      search: SEARCH,
    }
    const nodes = {}
    for (const [name, selector] of Object.entries(selectors)) {
      const { nodeId } = await command('DOM.querySelector', { nodeId: root.nodeId, selector })
      if (!nodeId && !popupOpen && ['popup', 'search'].includes(name)) continue
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
      join(resultDir, `project-create-collaborator-${phase}-ax.json`),
      JSON.stringify(observations, null, 2)
    )
    for (const name of ['taskTab', 'home'])
      assert.ok(
        !exposed[name] || exposed[name].ignored,
        `${phase}: background ${name} was exposed in the AX tree: ${JSON.stringify(observations[name])}`
      )
    assert.equal(exposed.main?.ignored, false, `${phase}: project dialog must remain accessible`)
    assert.equal(exposed.main.role?.value, 'dialog')
    assert.ok(exposed.main.name?.value?.trim())
    assert.equal(
      exposed.main.properties?.find(property => property.name === 'modal')?.value?.value,
      true
    )
    if (!popupOpen)
      for (const name of ['popup', 'search'])
        assert.ok(
          !exposed[name] || exposed[name].ignored,
          `${phase}: closed collaborator ${name} must not remain accessible`
        )
    if (popupOpen) {
      assert.equal(exposed.popup?.ignored, false, 'Open collaborator dialog must be accessible')
      assert.equal(exposed.popup.role?.value, 'dialog')
      assert.ok(exposed.popup.name?.value?.trim())
      assert.equal(exposed.search?.ignored, false, 'Collaborator search must be accessible')
      assert.equal(exposed.search.role?.value, 'textbox')
      assert.ok(exposed.search.name?.value?.trim())
      assert.equal(
        exposed.search.properties?.find(property => property.name === 'focusable')?.value?.value,
        true
      )
    }
  })
}
