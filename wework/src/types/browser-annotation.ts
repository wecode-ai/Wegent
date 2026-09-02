export type BrowserAdjustmentProperty =
  | 'text'
  | 'color'
  | 'background-color'
  | 'opacity'
  | 'font-family'
  | 'font-size'
  | 'font-weight'
  | 'width'
  | 'height'
  | 'padding'
  | 'margin'
  | 'border-radius'
  | 'border-color'
  | 'border-width'

export interface StyleAdjustment {
  property: BrowserAdjustmentProperty
  before: string
  after: string
}

export interface BrowserAnnotationRect {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserAnnotationScrollContainer {
  selector: string
  left: number
  top: number
}

export interface BrowserElementAnchor {
  kind: 'element'
  pageUrl: string
  frameUrl: string
  framePath: string[]
  selector: string
  elementPath: string[]
  tagName: string
  role?: string
  name?: string
  title?: string
  immediateText?: string
  nearbyText?: string
  rect: BrowserAnnotationRect
  fixedPosition: boolean
  scrollContainers: BrowserAnnotationScrollContainer[]
}

export interface BrowserTextAnchor {
  kind: 'text'
  pageUrl: string
  frameUrl: string
  framePath: string[]
  selectedText: string
  rect: BrowserAnnotationRect
  selectionRects: BrowserAnnotationRect[]
}

export interface BrowserRegionAnchor {
  kind: 'region'
  pageUrl: string
  frameUrl: string
  framePath: string[]
  rect: BrowserAnnotationRect
}

export type BrowserAnnotationAnchor = BrowserElementAnchor | BrowserTextAnchor | BrowserRegionAnchor

export interface BrowserDesignChange {
  property: string
  value: string
  previousValue: string
}

export interface BrowserAnnotationComment {
  id: string
  number: number
  comment: string
  anchor: BrowserAnnotationAnchor
  designChanges: BrowserDesignChange[]
  textChange: { before: string; after: string } | null
  screenshotDataUrl: string | null
  createdAt: string
  updatedAt: string
}

export interface BrowserAnnotationState {
  label: string
  mode: 'off' | 'quick' | 'batch'
  scope: BrowserAnnotationScope | null
  revision: number
  runtimeRevision: number
  comments: BrowserAnnotationComment[]
  originalView: boolean
  unresolvedIds: string[]
}

export interface BrowserAnnotationScope {
  browserTabId: string
  pageSessionId: string
  url: string
}

export interface BrowserAnnotationTargetSnapshot {
  tagName: string
  text: string
  isSimpleText?: boolean
  role?: string
  name?: string
  inspectId?: string
  ref?: string
  rect: BrowserAnnotationRect
  matchConfidence?: number
}

export interface BrowserAnnotationContextData {
  scope: BrowserAnnotationScope
  number: number
  target: BrowserAnnotationTargetSnapshot
  anchor?: BrowserAnnotationAnchor
  screenshotDataUrl?: string | null
}

export interface PageAnnotationDto {
  id: string
  number: number
  comment: string
  adjustments: StyleAdjustment[]
  target: BrowserAnnotationTargetSnapshot
  createdAt: string
  updatedAt: string
}

export interface BrowserAnnotationSnapshot {
  scope: BrowserAnnotationScope
  revision: number
  annotations: PageAnnotationDto[]
}

export interface BrowserAnnotationCommand {
  sequence: number
  type: 'clear_all_and_exit'
  reason: 'composer_clear' | 'send_success' | 'task_reset'
}
