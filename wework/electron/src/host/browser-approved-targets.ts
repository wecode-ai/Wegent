import type { DebuggerSession } from './debugger-session.js'

type Target = Pick<DebuggerSession, 'sendCommand'>

export interface BrowserTargetPage {
  contentsId: number
  url: string
  navigationRevision: number
}

export interface BrowserUploadTargetSnapshot extends BrowserTargetPage {
  selector: string
  backendNodeId: number
}

export interface BrowserClickTransform {
  scale: number
  metricsRevision: number
  emulated: boolean
}

export interface BrowserNativeClickTargetSnapshot extends BrowserTargetPage, BrowserClickTransform {
  frameId: string
  backendNodeId: number
}

export function sameTargetPage(left: BrowserTargetPage, right: BrowserTargetPage): boolean {
  return (
    left.contentsId === right.contentsId &&
    left.url === right.url &&
    left.navigationRevision === right.navigationRevision
  )
}

export function sameClickTransform(
  left: BrowserClickTransform,
  right: BrowserClickTransform
): boolean {
  return (
    left.scale === right.scale &&
    left.metricsRevision === right.metricsRevision &&
    left.emulated === right.emulated
  )
}

export function sameNativeClickTarget(
  left: BrowserNativeClickTargetSnapshot,
  right: BrowserNativeClickTargetSnapshot
): boolean {
  return (
    sameTargetPage(left, right) &&
    sameClickTransform(left, right) &&
    left.frameId === right.frameId &&
    left.backendNodeId === right.backendNodeId
  )
}

export function approvalTargetChanged(message: string): Error {
  return Object.assign(new Error(message), { code: 'approval_target_changed' })
}

export function nativeClickPoint(x: number, y: number) {
  return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) }
}

export async function resolveNativeClickTarget(
  target: Target,
  point: { x: number; y: number },
  scale: number
): Promise<{ frameId: string; backendNodeId: number }> {
  const cssX = point.x / scale
  const cssY = point.y / scale
  const { backendNodeId, frameId } = (await target.sendCommand('DOM.getNodeForLocation', {
    x: Math.floor(cssX),
    y: Math.floor(cssY),
  })) as { backendNodeId?: number; frameId?: string }
  if (typeof backendNodeId !== 'number' || !frameId) {
    throw approvalTargetChanged('The click target could not be verified.')
  }
  // CDP accepts integer CSS coordinates, but native events can map to
  // fractional pixels under zoom or device emulation. Require an unambiguous hit.
  for (const x of new Set([Math.floor(cssX), Math.ceil(cssX)])) {
    for (const y of new Set([Math.floor(cssY), Math.ceil(cssY)])) {
      if (x === Math.floor(cssX) && y === Math.floor(cssY)) continue
      const adjacent = (await target.sendCommand('DOM.getNodeForLocation', { x, y })) as {
        backendNodeId?: number
        frameId?: string
      }
      if (adjacent.backendNodeId !== backendNodeId || adjacent.frameId !== frameId) {
        throw approvalTargetChanged('The click coordinates do not identify one target.')
      }
    }
  }
  return { frameId, backendNodeId }
}

export async function resolveFileInputTarget(
  target: Target,
  selector: string | null
): Promise<{ selector: string; nodeId: number; backendNodeId: number }> {
  const effectiveSelector = selector?.trim() || 'input[type="file"]'
  const { root } = (await target.sendCommand('DOM.getDocument', { depth: 1 })) as {
    root: { nodeId: number }
  }
  const { nodeId } = (await target.sendCommand('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: effectiveSelector,
  })) as { nodeId: number }
  if (!nodeId) {
    throw new Error(
      `No file input element matches selector "${effectiveSelector}" in the embedded browser.`
    )
  }
  const { node } = (await target.sendCommand('DOM.describeNode', { nodeId })) as {
    node?: { backendNodeId?: number; nodeName?: string; attributes?: string[] }
  }
  if (
    node?.nodeName?.toUpperCase() !== 'INPUT' ||
    !hasFileInputAttribute(node.attributes ?? []) ||
    typeof node.backendNodeId !== 'number'
  ) {
    throw new Error(
      `Matched element for selector "${effectiveSelector}" is not a file input in the embedded browser.`
    )
  }
  return { selector: effectiveSelector, nodeId, backendNodeId: node.backendNodeId }
}

function hasFileInputAttribute(attributes: string[]): boolean {
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    if (
      attributes[index]?.toLowerCase() === 'type' &&
      attributes[index + 1]?.toLowerCase() === 'file'
    )
      return true
  }
  return false
}
