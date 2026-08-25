import { cn } from '@/lib/utils'

const recipes: Record<string, string> = {
  'automation-root':
    'relative h-full min-h-0 w-full min-w-0 overflow-hidden bg-background text-base text-text-primary',
  'project-editor-host': 'h-full min-h-0 w-full min-w-0',
  'project-content': 'h-full min-h-0 w-full overflow-y-auto bg-background px-6 pb-10 pt-5 xl:px-8',
  'project-page-title':
    'mb-5 flex items-start justify-between gap-4 border-b border-border/60 pb-5 [&_h1]:heading-medium [&_h1]:text-text-primary [&_p]:mt-1 [&_p]:text-sm [&_p]:text-text-muted',
  'project-page-actions': 'flex shrink-0 items-center gap-2',
  'project-primary-action':
    'inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-text-primary bg-text-primary px-4 text-sm font-medium text-background transition-colors hover:bg-text-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30',
  'project-secondary-action':
    'inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 text-sm text-text-secondary transition-colors hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/20',
  'back-to-automation':
    'mb-4 inline-flex h-8 items-center gap-2 rounded-lg px-2 text-sm text-text-secondary hover:bg-muted hover:text-text-primary',
  'automation-home': 'min-w-0',
  'project-runs-section': 'min-w-0',
  'home-toolbar': 'mb-5 flex items-center justify-between gap-4',
  'filter-tabs':
    'flex items-center gap-1 rounded-xl bg-muted p-1 [&>button]:inline-flex [&>button]:h-8 [&>button]:items-center [&>button]:gap-2 [&>button]:rounded-lg [&>button]:px-3 [&>button]:text-sm [&>button]:text-text-secondary [&>button]:transition-colors [&>button:hover]:bg-background/70 [&>button.active]:bg-background [&>button.active]:font-medium [&>button.active]:text-text-primary [&>button.active]:shadow-sm',
  'toolbar-actions': 'flex items-center gap-2',
  'quiet-filter':
    'inline-flex h-9 items-center gap-2 rounded-lg bg-muted px-3 text-sm text-text-secondary hover:text-text-primary',
  'home-search':
    'flex h-9 w-72 items-center gap-2 rounded-lg bg-muted px-3 text-sm text-text-secondary ring-1 ring-transparent transition focus-within:bg-background focus-within:ring-focus/40 [&_input]:min-w-0 [&_input]:flex-1 [&_input]:bg-transparent [&_input]:text-sm [&_input]:text-text-primary [&_input]:outline-none [&_input::placeholder]:text-text-muted [&_button]:grid [&_button]:size-5 [&_button]:place-items-center [&_button]:rounded hover:[&_button]:bg-border/60',
  'automation-grid': 'grid grid-cols-4 gap-4 max-xl:grid-cols-3 max-lg:grid-cols-2',
  'create-card':
    'flex min-h-56 flex-col rounded-2xl border border-border/80 bg-background p-5 [&_h2]:mb-5 [&_h2]:text-base [&_h2]:font-medium [&>button]:grid [&>button]:grid-cols-[32px_minmax(0,1fr)] [&>button]:items-center [&>button]:gap-3 [&>button]:rounded-xl [&>button]:px-3 [&>button]:py-3 [&>button]:text-left [&>button]:text-text-secondary [&>button]:transition-colors [&>button:hover]:bg-muted [&>button:hover]:text-text-primary [&>button>span]:grid [&>button>span]:gap-0.5 [&>button_strong]:text-sm [&>button_strong]:font-medium [&>button_small]:text-xs [&>button_small]:text-text-muted',
  'automation-card':
    'relative flex min-h-56 cursor-pointer flex-col rounded-2xl border border-border/80 bg-background p-5 text-left transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-text-primary/15 hover:shadow-lg',
  'card-head':
    'grid grid-cols-[44px_minmax(0,1fr)_28px] items-start gap-3 [&_h3]:truncate [&_h3]:text-base [&_h3]:font-medium [&_p]:mt-1 [&_p]:line-clamp-2 [&_p]:text-sm [&_p]:text-text-muted',
  'automation-icon':
    'grid size-11 shrink-0 place-items-center rounded-xl bg-[#f4eadc] text-[#8a5b20] [&.small]:size-9 [&.small]:rounded-lg',
  'icon-button':
    'grid size-7 place-items-center rounded-lg text-text-muted hover:bg-muted hover:text-text-primary',
  'card-menu-anchor': 'relative',
  'card-menu':
    'absolute right-0 top-8 z-popover grid w-36 gap-1 rounded-xl border border-border bg-popover p-1.5 shadow-xl [&_button]:flex [&_button]:h-8 [&_button]:items-center [&_button]:gap-2 [&_button]:rounded-lg [&_button]:px-2.5 [&_button]:text-sm [&_button]:text-text-secondary [&_button:hover]:bg-muted [&_button.danger]:text-destructive',
  'trigger-summary':
    'mt-5 grid gap-1 rounded-xl bg-muted px-4 py-3 [&>span]:flex [&>span]:items-center [&>span]:gap-2 [&>span]:text-xs [&>span]:text-text-secondary [&_strong]:truncate [&_strong]:text-sm [&_strong]:font-medium [&_strong]:text-text-primary [&_small]:line-clamp-2 [&_small]:text-xs [&_small]:text-text-muted',
  'card-footer':
    'mt-auto flex items-center justify-between border-t border-border/50 pt-4 text-xs text-text-muted',
  'run-dot':
    'size-2 rounded-full bg-text-muted/50 [&.success]:bg-success [&.failed]:bg-destructive [&.running]:bg-amber-500',
  switch:
    'relative h-5 w-9 rounded-full bg-border transition-colors [&_i]:absolute [&_i]:left-0.5 [&_i]:top-0.5 [&_i]:size-4 [&_i]:rounded-full [&_i]:bg-background [&_i]:shadow-sm [&_i]:transition-transform [&.on]:bg-focus [&.on_i]:translate-x-4',
  'home-empty':
    'grid min-h-60 place-items-center content-center gap-2 rounded-2xl border border-dashed border-border text-center text-text-muted [&_strong]:text-sm [&_strong]:font-medium [&_strong]:text-text-primary [&_span]:text-sm',
  toast:
    'fixed bottom-6 right-6 z-critical flex h-11 items-center gap-2 rounded-xl border border-border bg-popover px-4 text-sm text-text-primary shadow-xl',
  'template-store-overlay':
    'fixed inset-0 z-modal grid place-items-center bg-black/35 p-6 backdrop-blur-[1px]',
  'template-store-dialog':
    'grid h-[min(760px,calc(100vh-48px))] w-[min(1180px,calc(100vw-48px))] grid-rows-[72px_minmax(0,1fr)] overflow-hidden rounded-2xl border border-border bg-background shadow-2xl',
  'template-store-header':
    'grid grid-cols-[minmax(0,1fr)_320px_36px] items-center gap-4 border-b border-border px-6 [&>div]:flex [&>div]:items-center [&>div]:gap-3 [&_h2]:heading-small [&_p]:mt-0.5 [&_p]:text-sm [&_p]:text-text-muted',
  'template-store-mark': 'grid size-10 place-items-center rounded-xl bg-[#f4eadc] text-[#8a5b20]',
  'template-search':
    'flex h-9 items-center gap-2 rounded-lg bg-muted px-3 text-text-muted ring-1 ring-transparent focus-within:bg-background focus-within:ring-focus/40 [&_input]:min-w-0 [&_input]:flex-1 [&_input]:bg-transparent [&_input]:text-sm [&_input]:text-text-primary [&_input]:outline-none [&_button]:grid [&_button]:size-5 [&_button]:place-items-center [&_button]:rounded',
  'template-store-close':
    'grid size-8 place-items-center rounded-lg text-text-muted hover:bg-muted hover:text-text-primary',
  'template-store-body': 'grid min-h-0 grid-cols-[180px_minmax(0,1fr)_320px]',
  'template-categories':
    'grid content-start gap-1 border-r border-border bg-surface/60 p-4 [&_button]:flex [&_button]:h-9 [&_button]:items-center [&_button]:gap-2 [&_button]:rounded-lg [&_button]:px-3 [&_button]:text-sm [&_button]:text-text-secondary [&_button:hover]:bg-muted [&_button.active]:bg-background [&_button.active]:font-medium [&_button.active]:text-text-primary [&_button.active]:shadow-sm',
  'template-library': 'min-h-0 overflow-y-auto p-5',
  'template-library-title':
    'mb-4 flex items-end justify-between gap-4 [&>div]:grid [&>div]:gap-1 [&_h3]:text-base [&_h3]:font-medium [&_span]:text-sm [&_span]:text-text-muted [&>small]:text-xs [&>small]:text-text-muted',
  'template-grid': 'grid grid-cols-2 gap-3',
  'template-card':
    'grid min-h-40 grid-rows-[1fr_38px] overflow-hidden rounded-xl border border-border bg-background transition-[border-color,box-shadow] hover:border-text-primary/20 hover:shadow-md [&.selected]:border-focus [&.selected]:ring-2 [&.selected]:ring-focus/10',
  'template-card-main': 'grid grid-cols-[40px_minmax(0,1fr)] items-start gap-3 p-4 text-left',
  'template-icon':
    'grid size-10 place-items-center rounded-xl bg-blue-50 text-focus [&.testing]:bg-violet-50 [&.testing]:text-violet-600 [&.schedule]:bg-amber-50 [&.schedule]:text-amber-600 [&.defect]:bg-red-50 [&.defect]:text-red-600',
  'template-card-copy':
    'grid min-w-0 gap-2 [&>span:first-child]:grid [&>span:first-child]:gap-0.5 [&_strong]:truncate [&_strong]:text-sm [&_strong]:font-medium [&>span:first-child_small]:text-xs [&>span:first-child_small]:text-text-muted [&_p]:line-clamp-2 [&_p]:text-sm [&_p]:text-text-secondary',
  'template-card-meta':
    'flex flex-wrap gap-1.5 [&_span]:rounded-md [&_span]:bg-muted [&_span]:px-2 [&_span]:py-1 [&_span]:text-xs [&_span]:text-text-secondary',
  'template-card-apply':
    'border-t border-border text-sm font-medium text-text-secondary hover:bg-muted hover:text-text-primary',
  'template-preview':
    'min-h-0 overflow-y-auto border-l border-border bg-surface/45 p-5 [&>p]:mt-3 [&>p]:text-sm [&>p]:text-text-secondary',
  'template-preview-head':
    'flex items-center gap-3 [&>div]:grid [&>div]:gap-0.5 [&_small]:text-xs [&_small]:text-text-muted [&_h3]:text-base [&_h3]:font-medium',
  'template-preview-trigger':
    'mt-5 grid grid-cols-[36px_minmax(0,1fr)] gap-3 rounded-xl border border-border bg-background p-3 [&>span]:grid [&>span]:size-9 [&>span]:place-items-center [&>span]:rounded-lg [&>span]:bg-blue-50 [&>span]:text-focus [&_div]:grid [&_div]:gap-0.5 [&_small]:text-xs [&_small]:text-text-muted [&_strong]:text-sm [&_strong]:font-medium',
  'template-preview-steps':
    'mt-5 grid gap-2 [&>small]:text-xs [&>small]:text-text-muted [&>div]:grid [&>div]:grid-cols-[24px_minmax(0,1fr)] [&>div]:items-center [&>div]:gap-2 [&>div]:rounded-lg [&>div]:bg-background [&>div]:p-3 [&>div>span]:grid [&>div>span]:size-6 [&>div>span]:place-items-center [&>div>span]:rounded-md [&>div>span]:bg-muted [&>div>span]:text-xs [&_strong]:text-sm [&_strong]:font-medium',
  'template-preview-footer':
    'mt-5 border-t border-border pt-4 [&_p]:mb-3 [&_p]:text-xs [&_p]:text-text-muted [&_button]:h-9 [&_button]:w-full [&_button]:rounded-lg [&_button]:bg-text-primary [&_button]:text-sm [&_button]:font-medium [&_button]:text-background [&_button:hover]:bg-text-primary/90',
  'template-empty':
    'col-span-2 grid min-h-56 place-items-center content-center gap-2 rounded-xl border border-dashed border-border text-center [&_strong]:text-sm [&_strong]:font-medium [&_span]:text-sm [&_span]:text-text-muted',
  'template-preview-empty': 'grid h-full place-items-center text-center text-sm text-text-muted',
  'editor-shell': 'h-full min-h-0 w-full min-w-0 overflow-hidden bg-background text-text-primary',
  'back-button':
    'grid size-8 shrink-0 place-items-center rounded-lg text-text-muted hover:bg-muted hover:text-text-primary',
  'dark-secondary':
    'inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-xs text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40',
  'publish-button':
    'inline-flex h-8 items-center gap-1.5 rounded-lg bg-focus px-3 text-xs font-medium text-white hover:bg-focus/90 disabled:cursor-not-allowed disabled:opacity-50',
  'editor-body': 'grid h-full min-h-0 grid-cols-[220px_minmax(520px,1fr)_400px]',
  'editor-leftbar':
    'flex min-h-0 flex-col border-r border-border bg-surface/60 p-3 text-text-secondary',
  'workflow-identity':
    'grid gap-2 border-b border-border px-1 pb-4 [&_input]:min-w-0 [&_input]:truncate [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-sm [&_input]:font-medium [&_input]:text-text-primary [&_input]:outline-none [&_small]:px-2 [&_small]:text-xs [&_small]:text-text-muted',
  'workflow-identity-top': 'flex items-center gap-2',
  'editor-nav':
    'mt-3 grid gap-1 [&_button]:flex [&_button]:h-10 [&_button]:items-center [&_button]:gap-3 [&_button]:rounded-lg [&_button]:px-3 [&_button]:text-sm [&_button]:text-text-secondary [&_button:hover]:bg-muted [&_button:hover]:text-text-primary [&_button.active]:bg-muted [&_button.active]:text-text-primary',
  'leftbar-trigger':
    'mt-auto border-t border-border pt-4 [&>span]:mb-2 [&>span]:block [&>span]:text-xs [&>span]:text-text-muted [&_button]:grid [&_button]:w-full [&_button]:grid-cols-[20px_minmax(0,1fr)] [&_button]:items-start [&_button]:gap-2 [&_button]:rounded-xl [&_button]:border [&_button]:border-focus/25 [&_button]:bg-focus/5 [&_button]:p-3 [&_button]:text-left [&_button]:text-focus [&_button_div]:grid [&_button_div]:min-w-0 [&_button_div]:gap-1 [&_button_strong]:truncate [&_button_strong]:text-xs [&_button_strong]:font-medium [&_button_small]:line-clamp-2 [&_button_small]:text-xs [&_button_small]:text-focus/65',
  'workflow-canvas': 'relative min-h-0 overflow-hidden bg-surface',
  'react-flow-workflow-canvas':
    'absolute inset-0 select-none font-sans [&_.react-flow]:bg-transparent [&_.react-flow__node]:font-sans [&_.react-flow__node.dragging]:z-10 [&_.react-flow__node.dragging]:will-change-transform [&_.react-flow__node:focus-visible]:outline-none [&_.react-flow__minimap]:overflow-hidden [&_.react-flow__minimap]:rounded-xl [&_.react-flow__minimap]:border [&_.react-flow__minimap]:border-border/70 [&_.react-flow__minimap]:bg-background/95 [&_.react-flow__minimap]:shadow-md',
  'automation-hidden-handle': '!size-px !border-0 !bg-transparent opacity-0',
  'automation-node-handle': '!h-4 !w-2 !rounded-sm !border-2 !border-background !bg-focus',
  'flow-node':
    'grid h-full w-full grid-cols-[38px_minmax(0,1fr)_18px] items-center gap-3 rounded-xl border border-border/80 bg-background p-3 text-left text-text-primary shadow-sm transition-[border-color,box-shadow] duration-150 hover:border-border hover:shadow-md [&.selected]:border-focus [&.selected]:shadow-md [&.selected]:ring-1 [&.selected]:ring-focus/20 [&>svg]:-rotate-90 [&>svg]:text-text-muted',
  'node-icon':
    'grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-text-secondary [&.trigger]:bg-focus [&.trigger]:text-white [&.step]:bg-violet-600 [&.step]:text-white [&.coordinator]:bg-violet-600 [&.coordinator]:text-white',
  'flow-node-copy':
    'grid min-w-0 gap-1 [&_small]:text-xs [&_small]:text-text-muted [&_strong]:truncate [&_strong]:text-sm [&_strong]:font-medium [&>span]:truncate [&>span]:text-xs [&>span]:text-text-muted',
  'subgraph-count': 'whitespace-nowrap rounded-md bg-muted px-2 py-1 text-xs text-text-secondary',
  'react-flow-dynamic-group':
    'relative h-full w-full overflow-hidden rounded-2xl border border-border/80 bg-background/95 shadow-sm [&.selected]:border-focus [&.selected]:shadow-md [&.selected]:ring-1 [&.selected]:ring-focus/20',
  'react-flow-group-header':
    'grid h-[88px] w-full cursor-grab grid-cols-[38px_minmax(0,1fr)_auto] items-center gap-3 border-0 border-b border-border/70 bg-background px-3.5 py-3 text-left text-text-primary active:cursor-grabbing [&>span:nth-child(2)]:grid [&>span:nth-child(2)]:gap-1 [&_small]:text-xs [&_small]:text-text-muted [&_strong]:text-sm [&_strong]:font-medium [&_em]:text-xs [&_em]:not-italic [&_em]:text-text-muted',
  'react-flow-group-label':
    'pointer-events-none absolute left-[18px] top-[99px] inline-flex items-center gap-1 text-xs text-text-muted',
  'react-flow-stage-node':
    'relative h-full w-full rounded-lg border border-border/80 bg-background shadow-sm [&.selected]:border-focus [&.selected]:shadow-md [&.selected]:ring-1 [&.selected]:ring-focus/20 [&:hover_.react-flow-stage-handle]:opacity-100 [&.selected_.react-flow-stage-handle]:opacity-100',
  'react-flow-stage-main':
    'grid h-full w-full cursor-grab grid-cols-[28px_minmax(0,1fr)] items-center gap-2 rounded-lg border-0 bg-transparent p-2 text-left text-text-primary active:cursor-grabbing [&>span:first-child]:grid [&>span:first-child]:size-7 [&>span:first-child]:place-items-center [&>span:first-child]:rounded-lg [&>span:first-child]:bg-focus/10 [&>span:first-child]:text-xs [&>span:first-child]:text-focus [&>span:last-child]:grid [&>span:last-child]:min-w-0 [&>span:last-child]:gap-1 [&_strong]:truncate [&_strong]:text-xs [&_strong]:font-medium [&_small]:text-xs [&_small]:text-text-muted',
  'react-flow-stage-handle':
    '!size-2.5 !border-2 !border-background !bg-focus opacity-0 transition-opacity',
  'react-flow-stage-add':
    'absolute -top-2.5 right-3 z-10 grid size-5 place-items-center rounded-full border border-focus bg-background text-focus hover:bg-focus hover:text-white',
  'react-flow-edge-insert': 'absolute z-20 transition-opacity',
  'react-flow-edge-insert-trigger':
    'grid size-[22px] place-items-center rounded-full border border-border-strong bg-background text-focus shadow-md transition hover:scale-110 hover:border-focus hover:bg-focus hover:text-white',
  'react-flow-edge-insert-menu':
    'absolute left-1/2 top-7 grid w-44 -translate-x-1/2 gap-1 rounded-xl border border-border bg-popover p-1 shadow-xl [&_button]:flex [&_button]:h-8 [&_button]:items-center [&_button]:gap-2 [&_button]:rounded-lg [&_button]:px-2 [&_button]:text-xs [&_button]:text-text-secondary [&_button:hover]:bg-muted',
  'react-flow-insert-node': 'relative size-9',
  'react-flow-insert-trigger':
    'grid size-9 place-items-center rounded-full border border-border bg-background text-text-muted shadow-sm hover:border-focus hover:text-focus',
  'react-flow-insert-menu':
    'absolute left-1/2 top-10 z-20 grid w-44 -translate-x-1/2 gap-1 rounded-xl border border-border bg-popover p-1 shadow-xl [&_button]:flex [&_button]:h-8 [&_button]:items-center [&_button]:gap-2 [&_button]:rounded-lg [&_button]:px-2 [&_button]:text-xs [&_button]:text-text-secondary [&_button:hover]:bg-muted',
  'canvas-mode-controls':
    '!m-4 grid w-10 gap-1 rounded-xl border border-border/80 bg-background/95 p-1 shadow-md [&_button]:grid [&_button]:size-8 [&_button]:place-items-center [&_button]:rounded-lg [&_button]:text-text-muted [&_button]:transition-colors [&_button:hover]:bg-muted [&_button:hover]:text-text-primary [&_button.active]:bg-focus/10 [&_button.active]:text-focus',
  'canvas-viewport-controls':
    '!m-4 flex h-9 items-center overflow-hidden rounded-xl border border-border/80 bg-background/95 px-1 shadow-md [&_button]:grid [&_button]:size-7 [&_button]:place-items-center [&_button]:rounded-lg [&_button]:text-text-muted [&_button]:transition-colors [&_button:hover]:bg-muted [&_button:hover]:text-text-primary [&_span]:min-w-12 [&_span]:text-center [&_span]:text-xs [&_span]:text-text-secondary',
  'editor-rightbar': 'flex min-h-0 flex-col border-l border-border bg-surface/60 text-text-primary',
  'editor-global-actions':
    'flex h-14 shrink-0 items-center justify-end gap-2 border-b border-border bg-background px-3',
  'editor-save-state':
    'mr-auto inline-flex min-w-0 items-center gap-1.5 text-xs text-text-muted [&_i]:size-1.5 [&_i]:shrink-0 [&_i]:rounded-full [&.saved_i]:bg-success [&.dirty_i]:bg-amber-500 [&.saving_i]:animate-pulse [&.saving_i]:bg-focus',
  'node-panel': 'flex min-h-0 flex-1 flex-col bg-surface/60 text-text-primary',
  'panel-head':
    'flex min-h-[76px] items-center gap-3 border-b border-border px-5 py-4 [&>div]:grid [&>div]:min-w-0 [&>div]:gap-0.5 [&_strong]:truncate [&_strong]:text-sm [&_strong]:font-medium [&_small]:text-xs [&_small]:text-text-muted',
  'panel-tabs':
    'flex h-11 items-end gap-5 border-b border-border px-5 [&_button]:h-full [&_button]:border-b-2 [&_button]:border-transparent [&_button]:text-xs [&_button]:text-text-muted [&_button.active]:border-focus [&_button.active]:text-text-primary',
  'panel-content': 'min-h-0 flex-1 overflow-y-auto bg-background p-5',
  'last-run-panel':
    'grid gap-2 rounded-xl border border-border bg-surface p-4 [&_strong]:text-sm [&_strong]:font-medium [&_span]:text-xs [&_span]:text-text-muted [&_button]:mt-2 h-8 rounded-lg border border-border bg-background text-xs hover:bg-muted',
  'prominent-trigger':
    'mb-5 flex gap-3 rounded-xl border border-focus/25 bg-focus/5 p-4 text-focus [&_div]:grid [&_div]:gap-1 [&_strong]:text-sm [&_strong]:font-medium [&_span]:text-xs [&_span]:text-focus/65',
  'coordinator-intro':
    'mb-5 flex items-start gap-3 rounded-xl border border-emerald-700/20 bg-emerald-50/50 p-4 text-emerald-800 [&>div]:grid [&>div]:flex-1 [&>div]:gap-1 [&_strong]:text-sm [&_strong]:font-medium [&_span]:text-xs [&_span]:text-emerald-800/65 [&>button]:grid [&>button]:size-8 [&>button]:place-items-center [&>button]:rounded-lg [&>button:hover]:bg-emerald-100',
  'panel-field':
    'mb-4 grid gap-2 [&>span]:flex [&>span]:items-center [&>span]:gap-2 [&>span]:text-xs [&>span]:font-medium [&>span]:text-text-secondary [&_select]:h-10 [&_select]:w-full [&_select]:rounded-lg [&_select]:border [&_select]:border-border [&_select]:bg-background [&_select]:px-3 [&_select]:text-sm [&_select]:text-text-primary [&_select]:outline-none [&_input]:h-10 [&_input]:w-full [&_input]:rounded-lg [&_input]:border [&_input]:border-border [&_input]:bg-background [&_input]:px-3 [&_input]:text-sm [&_input]:text-text-primary [&_input]:outline-none [&_textarea]:min-h-32 [&_textarea]:w-full [&_textarea]:resize-y [&_textarea]:rounded-lg [&_textarea]:border [&_textarea]:border-border [&_textarea]:bg-background [&_textarea]:p-3 [&_textarea]:text-sm [&_textarea]:text-text-primary [&_textarea]:outline-none [&_select:focus]:border-focus [&_input:focus]:border-focus [&_textarea:focus]:border-focus',
  'cascade-index':
    'grid size-5 shrink-0 place-items-center rounded-md bg-focus/10 text-xs not-italic text-focus',
  'schedule-settings': 'border-t border-border pt-4',
  'start-mode-section': 'border-t border-border pt-4',
  'cascade-heading':
    'mb-3 flex items-start gap-2 [&>div]:grid [&>div]:gap-0.5 [&_strong]:text-xs [&_strong]:font-medium [&_span]:text-xs [&_span]:text-text-muted',
  'start-mode-options':
    'grid gap-2 [&>button]:grid [&>button]:grid-cols-[28px_minmax(0,1fr)] [&>button]:items-center [&>button]:gap-3 [&>button]:rounded-xl [&>button]:border [&>button]:border-border [&>button]:bg-background [&>button]:p-4 [&>button]:text-left [&>button:hover]:border-focus/35 [&>button.selected]:border-focus [&>button.selected]:bg-focus/5 [&>button.selected_.start-mode-radio]:border-focus [&>button.selected_.start-mode-radio]:bg-focus [&>button.selected_.start-mode-radio]:text-white [&>button>span:last-child]:grid [&>button>span:last-child]:gap-1 [&_strong]:text-sm [&_strong]:font-medium [&_small]:text-xs [&_small]:text-text-muted',
  'start-mode-radio':
    'grid size-6 place-items-center rounded-full border border-border-strong text-transparent',
  'tag-filter': 'mt-4 border-t border-border pt-4',
  'tag-filter-heading':
    'mb-3 flex items-start justify-between gap-3 [&>div]:grid [&>div]:gap-0.5 [&_strong]:text-xs [&_strong]:font-medium [&_span]:text-xs [&_span]:text-text-muted',
  'tag-options':
    'flex flex-wrap gap-2 [&_button]:flex [&_button]:h-8 [&_button]:items-center [&_button]:gap-2 [&_button]:rounded-lg [&_button]:border [&_button]:border-border [&_button]:bg-background [&_button]:px-3 [&_button]:text-xs [&_button]:text-text-secondary [&_button>span]:size-4 [&_button>span]:rounded [&_button>span]:border [&_button>span]:border-border-strong [&_button.selected]:border-focus [&_button.selected]:bg-focus/5 [&_button.selected]:text-focus [&_button.selected>span]:border-focus [&_button.selected>span]:bg-focus',
  'execution-status-scope':
    'mt-4 border-t border-border pt-4 [&>p]:mt-3 [&>p]:text-xs [&>p]:text-text-muted',
  'execution-status-list':
    'grid grid-cols-2 gap-2 [&_button]:flex [&_button]:h-10 [&_button]:items-center [&_button]:gap-2 [&_button]:rounded-lg [&_button]:border [&_button]:border-border [&_button]:bg-background [&_button]:px-3 [&_button]:text-xs [&_button]:text-text-secondary [&_button:hover]:border-focus/35 [&_button.selected]:border-focus [&_button.selected]:bg-focus/5 [&_button.selected]:text-focus [&_svg]:text-focus',
  'trigger-explanation':
    'mt-5 flex gap-3 rounded-xl border border-focus/25 bg-focus/5 p-4 text-focus [&>svg]:mt-0.5 [&_div]:grid [&_div]:gap-1 [&_strong]:text-sm [&_strong]:font-medium [&_p]:text-xs [&_p]:text-focus/65',
  'node-model-settings':
    'mb-4 rounded-xl border border-border bg-surface p-4 [&.coordinator-model-settings]:border-emerald-700/20 [&.coordinator-model-settings]:bg-emerald-50/40',
  'panel-plugins':
    'relative flex min-h-10 flex-wrap items-center gap-2 rounded-lg border border-border bg-background p-2 [&_button]:inline-flex h-7 items-center gap-1 rounded-md bg-muted px-2 text-xs text-text-secondary [&_button.add]:border border-dashed border-border-strong bg-transparent hover:bg-muted',
  'plugin-popover':
    'absolute left-0 top-[calc(100%+8px)] z-popover grid w-56 gap-1 rounded-xl border border-border bg-popover p-1.5 shadow-2xl [&_button]:flex [&_button]:h-9 [&_button]:items-center [&_button]:gap-2 [&_button]:rounded-lg [&_button]:bg-transparent [&_button]:px-2.5 [&_button]:text-xs [&_button]:text-text-secondary [&_button:hover]:bg-muted [&_button>span]:grid [&_button>span]:size-4 [&_button>span]:place-items-center [&_button>span]:rounded [&_button>span]:border [&_button>span]:border-border-strong [&_button>span.checked]:border-focus [&_button>span.checked]:bg-focus',
  'subgraph-mode-settings':
    'mb-4 flex items-center justify-between gap-3 rounded-xl border border-emerald-700/20 bg-emerald-50/40 p-4 [&>div]:flex [&>div]:min-w-0 [&>div]:flex-1 [&>div]:items-start [&>div]:gap-2 [&>div>span]:grid [&>div>span]:min-w-0 [&>div>span]:flex-1 [&>div>span]:gap-1 [&_span]:text-xs [&_span]:text-emerald-800/70 [&_strong]:text-sm [&_strong]:font-medium [&_small]:text-xs [&_small]:text-emerald-800/60 [&>button]:relative [&>button]:h-5 [&>button]:w-9 [&>button]:shrink-0 [&>button]:rounded-full [&>button]:bg-border [&>button_i]:absolute [&>button_i]:left-0.5 [&>button_i]:top-0.5 [&>button_i]:size-4 [&>button_i]:rounded-full [&>button_i]:bg-background [&>button_i]:shadow-sm [&>button_i]:transition-transform [&>button.enabled]:bg-emerald-600 [&>button.enabled_i]:translate-x-4',
  'dag-stage-settings-intro':
    'mb-5 flex items-start gap-3 rounded-xl border border-emerald-700/20 bg-emerald-50/40 p-4 text-emerald-800 [&>div]:grid [&>div]:flex-1 [&>div]:gap-1 [&_strong]:text-sm [&_strong]:font-medium [&_span]:text-xs [&_span]:text-emerald-800/60 [&>button]:grid [&>button]:size-8 [&>button]:place-items-center [&>button]:rounded-lg [&>button]:text-emerald-800/60 [&>button:hover]:bg-emerald-100 [&>button:hover]:text-emerald-800',
  'dag-stage-dependency-summary':
    'mb-4 grid gap-2 rounded-xl border border-border bg-surface p-4 text-xs text-text-muted [&>span]:font-medium [&>span]:text-text-secondary [&>div]:flex [&>div]:flex-wrap [&>div]:gap-2 [&_em]:rounded-md [&_em]:bg-focus/10 [&_em]:px-2 [&_em]:py-1 [&_em]:not-italic [&_em]:text-focus [&_small]:text-text-muted [&_p]:text-text-muted',
  'deliverables-section': 'mb-4 border-t border-border pt-4',
  'section-heading':
    'mb-3 flex items-center justify-between gap-3 [&_strong]:text-xs [&_strong]:font-medium [&_button]:inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-focus [&_button:hover]:bg-muted',
  'deliverable-list': 'overflow-hidden rounded-xl border border-border bg-surface',
  'deliverable-item':
    'grid grid-cols-[minmax(0,1fr)_64px_28px] items-center gap-2 p-3 [&+.deliverable-item]:border-t [&+.deliverable-item]:border-border [&>div]:grid [&>div]:gap-1 [&_input]:h-auto [&_input]:border-0 [&_input]:bg-transparent [&_input]:p-0 [&_input]:text-sm [&_input]:text-text-primary [&_input]:outline-none [&_input+input]:text-xs [&_input+input]:text-text-muted [&>span]:rounded-md [&>span]:bg-muted [&>span]:px-2 [&>span]:py-1 [&>span]:text-center [&>span]:text-xs [&>span]:text-text-secondary [&>button]:grid [&>button]:size-7 [&>button]:place-items-center [&>button]:rounded-lg [&>button]:text-text-muted [&>button:hover]:bg-muted [&>button:hover]:text-destructive',
  'empty-deliverables':
    'grid min-h-20 place-items-center rounded-xl border border-dashed border-border text-xs text-text-muted',
  'execution-mode':
    'mb-4 border-0 p-0 [&_legend]:mb-3 [&_legend]:text-xs [&_legend]:font-medium [&>div]:grid [&>div]:grid-cols-2 [&>div]:gap-2 [&_button]:flex [&_button]:h-11 [&_button]:items-center [&_button]:justify-center [&_button]:gap-2 [&_button]:rounded-xl [&_button]:border [&_button]:border-border [&_button]:bg-background [&_button]:text-sm [&_button]:text-text-secondary [&_button:hover]:border-focus/35 [&_button.selected]:border-focus [&_button.selected]:bg-focus/5 [&_button.selected]:text-focus',
  'execution-hint': 'mb-4 text-xs text-text-muted',
  'required-node':
    'mb-4 flex items-center gap-2 text-xs font-medium text-text-secondary [&_input]:size-4 [&_input]:accent-focus',
  'panel-help': 'mb-4 rounded-xl bg-muted p-3 text-xs text-text-muted [&_p]:leading-relaxed',
  'delete-step':
    'inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-destructive/30 text-xs text-destructive hover:bg-destructive/10',
  'rule-runs-view': 'flex min-h-0 flex-col gap-4 bg-background p-5 text-text-primary',
  'rule-runs-header':
    'flex items-center justify-between gap-4 [&_h2]:text-base [&_h2]:font-medium [&_p]:mt-1 [&_p]:text-xs [&_p]:text-text-muted',
  'rule-run-filters':
    'flex gap-1 rounded-lg bg-muted p-1 [&_button]:h-7 [&_button]:rounded-md [&_button]:px-2.5 [&_button]:text-xs [&_button]:text-text-secondary [&_button:hover]:text-text-primary [&_button.active]:bg-background [&_button.active]:text-text-primary [&_button.active]:shadow-sm',
  'rule-runs-list': 'min-h-0 overflow-hidden rounded-xl border border-border bg-background',
  'rule-runs-list-head':
    'grid grid-cols-[minmax(0,1fr)_90px_130px_70px] gap-3 border-b border-border bg-surface px-4 py-3 text-xs text-text-muted',
  'rule-run-row':
    'grid w-full grid-cols-[minmax(0,1fr)_90px_130px_70px] items-center gap-3 border-b border-border px-4 py-3 text-left hover:bg-muted/60 [&.selected]:bg-focus/5 [&>span:first-child]:grid [&>span:first-child]:gap-1 [&_strong]:truncate [&_strong]:text-xs [&_strong]:font-medium [&_small]:text-xs [&_small]:text-text-muted',
  'rule-runs-empty':
    'grid min-h-56 place-items-center content-center gap-2 rounded-xl border border-dashed border-border text-center [&_strong]:text-sm [&_strong]:font-medium [&_span]:text-xs [&_span]:text-text-muted',
  'run-detail-panel':
    'min-h-0 flex-1 overflow-y-auto bg-background p-4 [&.empty]:grid [&.empty]:place-items-center [&.empty]:content-center [&.empty]:gap-2 [&.empty]:text-center [&.empty_strong]:text-sm [&.empty_strong]:font-medium [&.empty_span]:text-xs [&.empty_span]:text-text-muted',
  'run-detail-head':
    'flex items-center gap-3 border-b border-border pb-4 [&>div]:grid [&>div]:gap-1 [&_strong]:text-sm [&_strong]:font-medium [&_small]:text-xs [&_small]:text-text-muted',
  'run-detail-icon':
    'grid size-10 place-items-center rounded-xl bg-muted text-text-muted [&.success]:bg-success/10 [&.success]:text-success [&.failed]:bg-destructive/10 [&.failed]:text-destructive [&.running]:bg-amber-500/10 [&.running]:text-amber-600',
  'run-detail-summary':
    'grid grid-cols-2 gap-3 border-b border-border py-4 [&>div]:grid [&>div]:gap-1 [&>div>span:first-child]:text-xs [&>div>span:first-child]:text-text-muted [&_strong]:text-xs [&_strong]:font-medium',
  'run-detail-steps':
    'grid gap-2 pt-4 [&>span]:text-xs [&>span]:text-text-muted [&>div]:flex [&>div]:items-start [&>div]:gap-3 [&>div]:rounded-lg [&>div]:bg-muted [&>div]:p-3 [&>div>div]:grid [&>div>div]:gap-1 [&_strong]:text-xs [&_strong]:font-medium [&_small]:text-xs [&_small]:text-text-muted',
  'run-step-state':
    'mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-surface text-text-muted [&.success]:text-success [&.failed]:text-destructive [&.running]:text-amber-600',
  'runs-home': 'min-w-0',
  'runs-title':
    'mb-4 flex items-end justify-between gap-4 [&_h1]:heading-small [&_p]:mt-1 [&_p]:text-sm [&_p]:text-text-muted',
  'run-filters':
    'flex gap-1 rounded-lg bg-muted p-1 [&_button]:h-8 [&_button]:rounded-md [&_button]:px-3 [&_button]:text-sm [&_button]:text-text-secondary [&_button.active]:bg-background [&_button.active]:font-medium [&_button.active]:text-text-primary [&_button.active]:shadow-sm',
  'runs-table': 'overflow-hidden rounded-xl border border-border',
  'runs-table-head':
    'grid grid-cols-[minmax(0,1fr)_120px_150px_80px] gap-3 border-b border-border bg-surface px-4 py-3 text-xs text-text-muted',
  'runs-row':
    'grid grid-cols-[minmax(0,1fr)_120px_150px_80px] items-center gap-3 border-b border-border/60 px-4 py-3 last:border-0 [&>span:first-child]:grid [&>span:first-child]:gap-1 [&_strong]:text-sm [&_strong]:font-medium [&_small]:text-xs [&_small]:text-text-muted [&>button]:text-xs [&>button]:text-focus hover:[&>button]:underline',
  'run-status':
    'inline-flex w-fit items-center rounded-md bg-muted px-2 py-1 text-xs text-text-secondary [&.success]:bg-success/10 [&.success]:text-success [&.failed]:bg-destructive/10 [&.failed]:text-destructive [&.running]:bg-amber-500/10 [&.running]:text-amber-600',
  spin: 'animate-spin',
}

export function automationClass(
  value: string,
  ...conditional: Array<string | false | null | undefined>
) {
  const semantic = cn(value, ...conditional)
  const utility = semantic
    .split(/\s+/)
    .filter(Boolean)
    .map(token => recipes[token])

  return cn(semantic, recipes[semantic], utility)
}
