// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  Background,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import { useMemo, type ReactNode } from "react";

import type { AutomationUiStep } from "../automation";

interface SimpleWorkflowDagProps {
  steps: AutomationUiStep[];
  selectedStepId: string | null;
  canManage: boolean;
  stepFallback(index: number): string;
  emptyDescription: string;
  executorName(step: AutomationUiStep): string | null;
  onSelectStep(stepId: string): void;
}

type WorkflowNode = Node<{ label: ReactNode }>;

export function SimpleWorkflowDag({
  steps,
  selectedStepId,
  canManage,
  stepFallback,
  emptyDescription,
  executorName,
  onSelectStep,
}: SimpleWorkflowDagProps) {
  const nodes = useMemo<WorkflowNode[]>(
    () =>
      steps.map((step, index) => ({
        id: step.id,
        position: { x: index * 232, y: 24 },
        data: {
          label: (
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
                {executorName(step) ? <em>{executorName(step)}</em> : null}
                <small>{step.prompt || emptyDescription}</small>
              </span>
            </button>
          ),
        },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: { width: 176 },
      })),
    [
      canManage,
      emptyDescription,
      executorName,
      onSelectStep,
      selectedStepId,
      stepFallback,
      steps,
    ],
  );
  const edges = useMemo<Edge[]>(() => {
    const stepIds = new Set(steps.map((step) => step.id));
    return steps.flatMap((step) =>
      step.dependencies
        .filter((dependencyId) => stepIds.has(dependencyId))
        .map((dependencyId) => ({
          id: `${dependencyId}-${step.id}`,
          source: dependencyId,
          target: step.id,
          type: "smoothstep",
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 14,
            height: 14,
            color: "rgb(var(--color-text-muted))",
          },
          style: {
            stroke: "rgb(var(--color-text-muted))",
            strokeWidth: 1.25,
          },
        })),
    );
  }, [steps]);

  return (
    <div
      className="automation-policy-workflow-dag"
      data-testid="automation-workflow-dag"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.15, minZoom: 0.65, maxZoom: 1 }}
        minZoom={0.65}
        maxZoom={1}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={18} size={1} color="rgb(var(--color-border) / 0.55)" />
      </ReactFlow>
    </div>
  );
}
