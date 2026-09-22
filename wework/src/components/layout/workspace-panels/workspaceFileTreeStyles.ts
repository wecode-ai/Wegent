export const PIERRE_WORKSPACE_FILE_TREE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-bg-muted-override: rgb(var(--color-muted));
    --trees-fg-override: rgb(var(--color-text-primary));
    --trees-fg-muted-override: rgb(var(--color-text-muted));
    --trees-border-color-override: rgb(var(--color-border));
    --trees-selected-bg-override: rgb(var(--color-bg-surface));
    --trees-selected-fg-override: rgb(var(--color-text-primary));
    --trees-selected-focused-border-color-override: rgb(var(--color-primary));
    --trees-focus-ring-color-override: rgb(var(--color-primary) / 0.35);
    --trees-focus-ring-width-override: 1px;
    --trees-focus-ring-offset-override: 0px;
    --trees-gap-override: 2px;
    --trees-level-gap-override: 6px;
    --trees-item-padding-x-override: 4px;
    --trees-item-margin-x-override: 0px;
    --trees-padding-inline-override: 4px;
    --trees-indent-guide-bg-override: rgb(var(--color-border));
    --trees-scrollbar-thumb-override: rgb(var(--color-text-muted) / 0.55);
    font-family: var(--font-ui);
    font-size: var(--text-sm);
    color: var(--trees-fg);
    background: transparent !important;
  }
  button[data-type='item'] {
    box-sizing: border-box;
    border-radius: 6px;
    color: var(--trees-fg);
    background: transparent;
    background-clip: padding-box;
  }
  button[data-type='item']:hover {
    color: rgb(var(--color-text-primary));
    background: rgb(var(--color-muted));
    box-shadow:
      0 0 0 1px rgb(var(--color-bg-base)),
      0 1px 2px rgb(0 0 0 / 0.04);
  }
  button[data-type='item'][data-item-selected] {
    color: rgb(var(--color-text-primary));
    background: rgb(var(--color-muted)) !important;
    box-shadow:
      0 0 0 1px rgb(var(--color-bg-base)),
      0 1px 2px rgb(0 0 0 / 0.04);
  }
  button[data-type='item'][data-item-selected='true']:has(+ [data-item-selected='true']),
  button[data-type='item'][data-item-selected='true'] + [data-item-selected='true'] {
    border-radius: 6px !important;
  }
  button[data-type='item'][data-item-focused='true']::before,
  button[data-type='item']:focus-visible::before {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--trees-focus-ring-color);
  }
  button[data-type='item'][data-item-focused='true'][data-item-selected='true']::before,
  button[data-type='item'][data-item-selected='true']:focus-visible::before {
    box-shadow: inset 0 0 0 1px var(--trees-selected-focused-border-color);
  }
`
