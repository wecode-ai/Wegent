import { Check, ChevronDown, Search } from "lucide-react";
import { useState } from "react";
import type { CollaborationTranslate } from "../i18n";
import {
  TARGET_ICONS,
  targetLabels,
  type TargetKind,
} from "../project-manage/automaticProcessing";

export function RuleTargetPicker({
  value,
  options,
  onChange,
  translate,
  testId,
}: {
  value: { kind: TargetKind; id: string };
  options: Record<TargetKind, { id: string; name: string }[]>;
  onChange(value: { kind: TargetKind; id: string }): void;
  translate: CollaborationTranslate;
  testId: string;
}) {
  const [targetPickerOpen, setTargetPickerOpen] = useState(false);
  const [targetQuery, setTargetQuery] = useState("");
  const targetKindLabel = targetLabels(translate);
  const targetKinds = (["human", "agent", "collaboration_group"] as const).map(
    (kind) => ({
      kind,
      label: targetKindLabel[kind],
      icon: TARGET_ICONS[kind],
      options: options[kind],
    }),
  );
  const selectedTargetName =
    options[value.kind].find((option) => option.id === value.id)?.name ??
    translate("common.select", "请选择");
  const filteredTargets = options[value.kind].filter((option) =>
    option.name
      .toLocaleLowerCase()
      .includes(targetQuery.trim().toLocaleLowerCase()),
  );
  const SelectedTargetIcon = TARGET_ICONS[value.kind];
  return (
    <section
      className="space-y-2"
      onKeyDown={(event) => {
        if (event.key === "Escape" && targetPickerOpen) {
          event.stopPropagation();
          setTargetPickerOpen(false);
          setTargetQuery("");
        }
      }}
    >
      <h3 className="text-sm font-medium text-text-primary">
        {translate("todo.assign_to", "交给")}
      </h3>
      <div
        className="grid grid-cols-3 gap-2"
        data-testid={`${testId}-target-kinds`}
      >
        {targetKinds.map((targetKind) => {
          const selected = value.kind === targetKind.kind;
          const available = targetKind.options.length > 0;
          const Icon = targetKind.icon;
          return (
            <button
              aria-pressed={selected}
              className={`flex min-w-0 items-center gap-2 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                selected
                  ? "automatic-processing-selected-soft"
                  : available
                    ? "border-border hover:bg-muted/60"
                    : "cursor-not-allowed border-border/60"
              }`}
              data-testid={`${testId}-target-kind-${targetKind.kind}`}
              disabled={!available}
              key={targetKind.kind}
              onClick={() => {
                const firstTarget = targetKind.options[0];
                onChange({ kind: targetKind.kind, id: firstTarget?.id ?? "" });
                setTargetPickerOpen(false);
                setTargetQuery("");
              }}
              type="button"
            >
              <Icon
                aria-hidden="true"
                className={`h-4 w-4 shrink-0 ${
                  selected
                    ? "automatic-processing-selected-icon"
                    : "text-text-secondary"
                }`}
              />
              <span className="min-w-0">
                <strong
                  className={`block truncate text-sm font-medium ${
                    available ? "text-text-primary" : "text-text-muted"
                  }`}
                >
                  {targetKind.label}
                </strong>
                <span
                  className={`block text-xs ${
                    available ? "text-text-secondary" : "text-text-muted"
                  }`}
                >
                  {available
                    ? `${targetKind.options.length} ${translate("automation_rules.available", "可用")}`
                    : translate("common.not_configured", "未配置")}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="relative">
        <button
          aria-expanded={targetPickerOpen}
          aria-haspopup="listbox"
          className={`automatic-processing-selected flex min-h-[68px] w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-shadow ${
            targetPickerOpen ? "automatic-processing-picker-open" : ""
          }`}
          data-testid={`${testId}-target`}
          onClick={() => {
            setTargetPickerOpen((open) => !open);
            setTargetQuery("");
          }}
          type="button"
        >
          <span className="automatic-processing-selected-avatar flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
            <SelectedTargetIcon aria-hidden="true" className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <strong className="block truncate text-sm font-medium text-text-primary">
              {selectedTargetName}
            </strong>
            <span className="mt-0.5 block text-xs text-text-secondary">
              {targetKindLabel[value.kind]}
            </span>
          </span>
          <ChevronDown
            aria-hidden="true"
            className={`h-4 w-4 shrink-0 text-text-muted transition-transform ${
              targetPickerOpen ? "rotate-180" : ""
            }`}
          />
        </button>

        {targetPickerOpen ? (
          <div
            className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-xl border border-border bg-surface shadow-lg"
            data-testid={`${testId}-target-picker`}
          >
            <div className="border-b border-border p-2">
              <label className="!flex h-8 items-center gap-2 rounded-lg border border-border bg-background px-3 keyboard:focus-within:border-focus">
                <Search
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 text-text-muted"
                />
                <input
                  autoFocus
                  className="!h-auto !min-h-0 min-w-0 flex-1 !border-0 !bg-transparent !p-0 text-sm text-text-primary outline-none placeholder:text-text-muted"
                  data-testid={`${testId}-target-search`}
                  onChange={(event) => setTargetQuery(event.target.value)}
                  placeholder={translate(
                    "todo.search_processing_target",
                    `搜索${targetKindLabel[value.kind]}`,
                  )}
                  value={targetQuery}
                />
              </label>
            </div>
            <div
              aria-label={translate("todo.processing_target", "处理对象")}
              className="max-h-52 overflow-y-auto p-2"
              role="listbox"
            >
              {filteredTargets.map((option) => {
                const selected = value.id === option.id;
                return (
                  <button
                    aria-selected={selected}
                    className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-muted"
                    data-testid={`${testId}-target-option-${value.kind}-${option.id}`}
                    key={option.id}
                    onClick={() => {
                      onChange({ kind: value.kind, id: option.id });
                      setTargetPickerOpen(false);
                      setTargetQuery("");
                    }}
                    role="option"
                    type="button"
                  >
                    <SelectedTargetIcon
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0 text-text-secondary"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                      {option.name}
                    </span>
                    {selected ? (
                      <Check
                        aria-hidden="true"
                        className="automatic-processing-selected-icon h-4 w-4 shrink-0"
                      />
                    ) : null}
                  </button>
                );
              })}
              {!filteredTargets.length ? (
                <p className="px-3 py-6 text-center text-sm text-text-secondary">
                  {translate(
                    "todo.no_matching_processing_target",
                    "没有匹配的处理对象",
                  )}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
