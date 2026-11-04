// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export function AutomaticProcessingSwitch({
  checked,
  disabled,
  label,
  onChange,
  testId,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange(checked: boolean): void;
  testId: string;
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className="inline-flex shrink-0 rounded-full focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50"
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span
        className={`relative inline-flex h-5 w-8 items-center rounded-full transition-colors ${
          checked ? "bg-blue-500" : "bg-text-muted/30"
        }`}
      >
        <span
          className={`h-4 w-4 rounded-full border border-white bg-white shadow-sm transition-transform ${
            checked ? "translate-x-[14px]" : "translate-x-0.5"
          }`}
        />
      </span>
    </button>
  );
}
