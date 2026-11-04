import type { CollaborationTranslate } from "../i18n";
import type { ConnectionRuleProcessing } from "./connectionRules";
import { AutomationInstructionField } from "./AutomationInstructionField";

/** The same condition and instruction fields serve personal and project rules. */
export function ConnectionRuleFields({
  value,
  onChange,
  translate,
  disabled,
  testId,
  sharedInstruction = false,
}: {
  value: ConnectionRuleProcessing;
  onChange(value: ConnectionRuleProcessing): void;
  translate: CollaborationTranslate;
  disabled?: boolean;
  testId: string;
  sharedInstruction?: boolean;
}) {
  const fieldClass =
    "min-h-11 w-full rounded-md border border-border bg-background px-3 py-2 text-sm md:min-h-8";
  return (
    <fieldset disabled={disabled} className="space-y-3" data-testid={testId}>
      <legend className="mb-2 text-sm font-medium">
        {translate("automation_rules.conditions", "满足条件时")}
      </legend>
      <label className="block space-y-1 text-sm">
        <span>
          {translate("automation_rules.contains", "消息包含（可选）")}
        </span>
        <input
          className={fieldClass}
          data-testid={`${testId}-contains`}
          value={value.condition?.contains ?? ""}
          onChange={(event) =>
            onChange({
              ...value,
              condition: { ...value.condition, contains: event.target.value },
            })
          }
        />
      </label>
      <label className="block space-y-1 text-sm">
        <span>{translate("automation_rules.sender", "发件人 ID（可选）")}</span>
        <input
          className={fieldClass}
          data-testid={`${testId}-sender`}
          value={value.condition?.senderId ?? ""}
          onChange={(event) =>
            onChange({
              ...value,
              condition: { ...value.condition, senderId: event.target.value },
            })
          }
        />
      </label>
      <label className="block space-y-1 border-t border-border pt-3 text-sm">
        <span>{translate("automation_rules.instruction", "如何处理")}</span>
        <p className="text-xs text-text-secondary">
          {sharedInstruction
            ? translate(
                "automation_rules.shared_instruction",
                "项目成员可见；执行对象只读取发布后的 Issue。",
              )
            : translate(
                "automation_rules.private_instruction",
                "仅本人可见，用于处理私人来源内容。",
              )}
        </p>
        <AutomationInstructionField
          className={fieldClass}
          rows={3}
          data-testid={`${testId}-instruction`}
          value={value.instruction ?? ""}
          onChange={(event) =>
            onChange({ ...value, instruction: event.target.value })
          }
        />
      </label>
    </fieldset>
  );
}
