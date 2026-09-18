import { useCollaborationPortalTheme } from "../theme";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";
import { activityClassNames as cn } from "../issue-detail/activityClassNames";

export function ProjectBoardGroupPicker({
  fields,
  value,
  onChange,
  testIdPrefix = "dingtalk-board-group",
  searchPlaceholder = "搜索表格字段",
  chooseLabel = "选择分组字段",
  emptyLabel = "没有匹配字段",
}: {
  fields: { id: string; name: string; type?: string }[];
  value: string;
  onChange: (fieldId: string) => void;
  testIdPrefix?: string;
  searchPlaceholder?: string;
  chooseLabel?: string;
  emptyLabel?: string;
}) {
  const portalTheme = useCollaborationPortalTheme();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
  const [query, setQuery] = useState("");
  const selected = fields.find((field) => field.id === value);
  const visibleFields = fields
    .filter((field) =>
      `${field.name} ${field.type ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .sort((left, right) => {
      const recommended = (field: { name: string }) =>
        /状态|负责人|优先级|所属项目/.test(field.name) ? 0 : 1;
      return recommended(left) - recommended(right);
    });

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const closeOnScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("scroll", closeOnScroll, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("scroll", closeOnScroll, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const openMenu = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const menuWidth = 256;
    const margin = 8;
    const estimatedHeight = 320;
    const left = Math.max(
      margin,
      Math.min(rect.left, window.innerWidth - menuWidth - margin),
    );
    const below = Math.round(rect.bottom + 4);
    const top =
      below + estimatedHeight <= window.innerHeight - margin
        ? below
        : Math.max(margin, Math.round(rect.top - 4 - estimatedHeight));
    setMenuPosition({ left: Math.round(left), top });
    setOpen(true);
    setQuery("");
  };

  return (
    <div ref={rootRef} className="shrink-0">
      <button
        ref={triggerRef}
        type="button"
        data-testid={`${testIdPrefix}-by`}
        onClick={openMenu}
        className="flex h-8 min-w-32 items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 text-xs text-text-secondary hover:bg-muted"
        aria-expanded={open}
        aria-haspopup="listbox"
        data-value={value}
      >
        <span className="max-w-32 truncate">
          {selected?.name ?? chooseLabel}
        </span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      {open
        ? createPortal(
            <div
              {...portalTheme}
              ref={menuRef}
              role="listbox"
              aria-label={chooseLabel}
              data-testid={`${testIdPrefix}-menu`}
              style={{
                ...portalTheme.style,
                left: menuPosition.left,
                top: menuPosition.top,
              }}
              className={`${portalTheme.className} fixed z-system-popover w-64 overflow-hidden rounded-xl border border-border bg-background p-1.5 shadow-lg`}
            >
              <label className="flex h-8 items-center gap-2 rounded-lg bg-muted px-2.5 text-text-muted">
                <Search className="h-3.5 w-3.5" />
                <input
                  autoFocus
                  data-testid={`${testIdPrefix}-search`}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={searchPlaceholder}
                  aria-label={searchPlaceholder}
                  className="min-w-0 flex-1 bg-transparent text-xs text-text-primary outline-none"
                />
              </label>
              <div className="mt-1 max-h-72 overflow-y-auto overscroll-contain">
                {visibleFields.map((field) => (
                  <button
                    key={field.id}
                    role="option"
                    aria-selected={field.id === value}
                    type="button"
                    data-testid={`${testIdPrefix}-option-${field.id}`}
                    onClick={() => {
                      onChange(field.id);
                      setOpen(false);
                      setQuery("");
                      triggerRef.current?.focus();
                    }}
                    className={cn(
                      "flex h-9 w-full items-center rounded-lg px-2.5 text-left text-sm hover:bg-muted",
                      field.id === value && "bg-muted font-medium",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {field.name}
                    </span>
                    <span className="ml-2 shrink-0 text-xs text-text-muted">
                      {field.type}
                    </span>
                    {field.id === value ? (
                      <Check className="ml-2 h-3.5 w-3.5" />
                    ) : null}
                  </button>
                ))}
                {visibleFields.length === 0 ? (
                  <p className="px-3 py-6 text-center text-xs text-text-muted">
                    {emptyLabel}
                  </p>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
