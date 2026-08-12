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
