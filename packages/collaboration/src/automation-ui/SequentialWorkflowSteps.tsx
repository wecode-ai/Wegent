// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { AutomationUiStep } from "../automation";

interface SequentialWorkflowStepsProps {
  steps: AutomationUiStep[];
  selectedStepId: string | null;
  canManage: boolean;
  stepFallback(index: number): string;
  emptyDescription: string;
  executorName(step: AutomationUiStep): string | null;
  onSelectStep(stepId: string): void;
}

export function SequentialWorkflowSteps({
  steps,
  selectedStepId,
  canManage,
  stepFallback,
  emptyDescription,
  executorName,
  onSelectStep,
}: SequentialWorkflowStepsProps) {
  return (
    <ol
      className="automation-policy-workflow-steps"
      data-testid="automation-workflow-steps"
    >
      {steps.map((step, index) => {
        const executor = executorName(step);
        return (
          <li key={step.id}>
            <button
              type="button"
              className={selectedStepId === step.id ? "is-selected" : ""}
              data-testid={`automation-workflow-step-${index}`}
              aria-pressed={selectedStepId === step.id}
              disabled={!canManage}
              onClick={() => onSelectStep(step.id)}
            >
              <span>{index + 1}</span>
              <span>
                <strong>{step.name || stepFallback(index + 1)}</strong>
                {executor ? <em>{executor}</em> : null}
                <small>{step.prompt || emptyDescription}</small>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
