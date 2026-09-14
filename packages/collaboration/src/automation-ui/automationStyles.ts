function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

const recipes: Record<string, string> = {
  "project-primary-action":
    "inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-text-primary bg-text-primary px-4 text-sm font-medium text-background transition-colors hover:bg-text-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30",
  "project-secondary-action":
    "inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 text-sm text-text-secondary transition-colors hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/20",
  "card-menu-action":
    "flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm text-text-secondary hover:bg-muted [&.danger]:text-destructive",
  "panel-field":
    "relative grid gap-2 [&>span]:flex [&>span]:items-center [&>span]:gap-2 [&>span]:text-sm [&>span]:font-medium [&>span]:text-text-secondary [&_select]:h-10 [&_select]:w-full [&_select]:rounded-lg [&_select]:border [&_select]:border-transparent [&_select]:bg-muted/60 [&_select]:px-3 [&_select]:text-sm [&_select]:text-text-primary [&_select]:outline-none [&_select]:transition-colors [&_input]:h-10 [&_input]:w-full [&_input]:rounded-lg [&_input]:border [&_input]:border-transparent [&_input]:bg-muted/60 [&_input]:px-3 [&_input]:text-sm [&_input]:text-text-primary [&_input]:outline-none [&_input]:transition-colors [&_input::placeholder]:text-text-muted [&_textarea]:min-h-28 [&_textarea]:w-full [&_textarea]:resize-y [&_textarea]:rounded-lg [&_textarea]:border [&_textarea]:border-transparent [&_textarea]:bg-muted/60 [&_textarea]:p-3 [&_textarea]:text-sm [&_textarea]:text-text-primary [&_textarea]:outline-none [&_textarea]:transition-colors [&_textarea::placeholder]:text-text-muted [&_select:hover]:bg-muted [&_input:hover]:bg-muted [&_textarea:hover]:bg-muted [&_select:focus]:border-focus/60 [&_select:focus]:bg-background [&_input:focus]:border-focus/60 [&_input:focus]:bg-background [&_textarea:focus]:border-focus/60 [&_textarea:focus]:bg-background",
  "cascade-index":
    "grid size-5 shrink-0 place-items-center rounded-md bg-focus/10 text-xs not-italic text-focus",
  "execution-hint": "text-xs leading-relaxed text-text-muted",
  "panel-help":
    "flex items-start gap-2 border-t border-border/60 pt-4 text-xs text-text-muted [&_svg]:mt-0.5 [&_svg]:shrink-0 [&_p]:leading-relaxed",
};

export function automationClass(
  value: string,
  ...conditional: Array<string | false | null | undefined>
) {
  const semantic = cn(value, ...conditional);
  const utility = semantic
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => recipes[token]);

  return cn(semantic, ...utility);
}
