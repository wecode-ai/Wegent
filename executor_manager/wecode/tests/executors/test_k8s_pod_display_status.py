# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for K8sExecutor._compute_pod_display_status (kubectl-style STATUS)."""

import pytest

from executor_manager.wecode.executors.k8s.k8s_executor import K8sExecutor


@pytest.mark.parametrize(
    "pod, expected",
    [
        # Healthy running pod: phase wins when no container overrides it.
        (
            {
                "status": {
                    "phase": "Running",
                    "containerStatuses": [{"state": {"running": {}}}],
                }
            },
            "Running",
        ),
        # OOMKilled container terminated reason overrides the phase.
        (
            {
                "status": {
                    "phase": "Failed",
                    "containerStatuses": [
                        {
                            "state": {
                                "terminated": {"reason": "OOMKilled", "exitCode": 137}
                            }
                        }
                    ],
                }
            },
            "OOMKilled",
        ),
        # Completed pod.
        (
            {
                "status": {
                    "phase": "Succeeded",
                    "containerStatuses": [
                        {
                            "state": {
                                "terminated": {"reason": "Completed", "exitCode": 0}
                            }
                        }
                    ],
                }
            },
            "Completed",
        ),
        # Waiting reason (e.g. CrashLoopBackOff) overrides the phase.
        (
            {
                "status": {
                    "phase": "Running",
                    "containerStatuses": [
                        {"state": {"waiting": {"reason": "CrashLoopBackOff"}}}
                    ],
                }
            },
            "CrashLoopBackOff",
        ),
        # Terminated without a reason falls back to ExitCode:N.
        (
            {
                "status": {
                    "phase": "Failed",
                    "containerStatuses": [{"state": {"terminated": {"exitCode": 2}}}],
                }
            },
            "ExitCode:2",
        ),
        # status.reason (e.g. Evicted) overrides the phase when no containers.
        ({"status": {"phase": "Failed", "reason": "Evicted"}}, "Evicted"),
        # deletionTimestamp means the pod is Terminating.
        (
            {
                "metadata": {"deletionTimestamp": "2026-07-22T00:00:00Z"},
                "status": {
                    "phase": "Running",
                    "containerStatuses": [{"state": {"running": {}}}],
                },
            },
            "Terminating",
        ),
        # Empty / missing status.
        ({}, ""),
        # Multi-container: a sidecar Completed while the main container is Running
        # and the pod is Ready -> healthy Running (not misreported as Completed).
        (
            {
                "status": {
                    "phase": "Running",
                    "conditions": [{"type": "Ready", "status": "True"}],
                    "containerStatuses": [
                        {"ready": True, "state": {"running": {}}},
                        {
                            "ready": False,
                            "state": {"terminated": {"reason": "Completed"}},
                        },
                    ],
                }
            },
            "Running",
        ),
        # Multi-container: sidecar Completed, main Running but pod not Ready ->
        # NotReady.
        (
            {
                "status": {
                    "phase": "Running",
                    "conditions": [{"type": "Ready", "status": "False"}],
                    "containerStatuses": [
                        {"ready": True, "state": {"running": {}}},
                        {
                            "ready": False,
                            "state": {"terminated": {"reason": "Completed"}},
                        },
                    ],
                }
            },
            "NotReady",
        ),
        # Multi-container: a container OOMKilled while another runs -> the abnormal
        # reason still wins (matches kubectl), so the pod is treated as abnormal.
        (
            {
                "status": {
                    "phase": "Running",
                    "conditions": [{"type": "Ready", "status": "True"}],
                    "containerStatuses": [
                        {
                            "ready": False,
                            "state": {"terminated": {"reason": "OOMKilled"}},
                        },
                        {"ready": True, "state": {"running": {}}},
                    ],
                }
            },
            "OOMKilled",
        ),
    ],
)
def test_compute_pod_display_status(pod, expected):
    assert K8sExecutor._compute_pod_display_status(pod) == expected
