# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Deterministic Backend checks for one plugin publication snapshot."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException

from app.schemas.installed_plugin import PluginUploadInfo
from app.services.plugin_package_parser import plugin_package_parser
from app.services.plugin_package_scanner import scan_plugin_package


@dataclass(frozen=True)
class PublicationCheckResult:
    code: str
    title: str
    severity: str
    status: str
    summary: str
    evidence: list[str]
    acknowledgement_required: bool = False
    execution_environment: str = "backend"


@dataclass(frozen=True)
class PublicationInspection:
    parsed: PluginUploadInfo
    security_report: dict[str, Any]
    checks: list[PublicationCheckResult]
    detected_risks: dict[str, bool]


class PluginPublicationCheckService:
    """Inspect an archive without claiming native operating-system execution."""

    def inspect(
        self,
        package: bytes,
        *,
        expected_slug: str,
        expected_version: str,
        risk_declaration: dict[str, Any],
        test_notes: str,
    ) -> PublicationInspection:
        security_report = scan_plugin_package(package)
        parsed = plugin_package_parser.parse_package(package)
        if parsed.name != expected_slug:
            raise HTTPException(
                status_code=422,
                detail="Plugin manifest name does not match the submitted slug",
            )
        if parsed.version != expected_version:
            raise HTTPException(
                status_code=422,
                detail="Plugin manifest version does not match requestedVersion",
            )

        components = parsed.components.model_dump(exclude_none=True)
        executable_paths = list(security_report.get("executablePaths") or [])
        runtime_components = [
            f"{kind}:{item.get('name', '')}"
            for kind in ("commands", "hooks", "bins", "mcps")
            for item in components.get(kind, [])
            if isinstance(item, dict)
        ]
        detected_commands = bool(executable_paths or runtime_components)
        declared_commands = bool(risk_declaration.get("executesCommands"))
        detected_risks = {
            "executesCommands": detected_commands,
            "runtimeCapabilities": bool(runtime_components),
        }
        checks = [
            PublicationCheckResult(
                code="package.archive_safety",
                title="Package archive safety",
                severity="blocker",
                status="passed",
                summary="ZIP paths, links, encryption, secrets, and size passed",
                evidence=[
                    f"entries={security_report.get('entryCount', 0)}",
                    f"expandedBytes={security_report.get('expandedSizeBytes', 0)}",
                ],
            ),
            PublicationCheckResult(
                code="package.manifest_contract",
                title="Manifest and version contract",
                severity="blocker",
                status="passed",
                summary="Manifest name and version match the submitted snapshot",
                evidence=[f"name={parsed.name}", f"version={parsed.version}"],
            ),
        ]
        checks.append(
            self._command_declaration_check(
                detected=detected_commands,
                declared=declared_commands,
                executable_paths=executable_paths,
                runtime_components=runtime_components,
            )
        )
        checks.extend(self._declared_risk_checks(risk_declaration))
        if not test_notes.strip():
            checks.append(
                PublicationCheckResult(
                    code="evidence.test_notes",
                    title="Testing evidence",
                    severity="warning",
                    status="warning",
                    summary="No submitter testing notes were provided",
                    evidence=[],
                    acknowledgement_required=True,
                )
            )
        else:
            checks.append(
                PublicationCheckResult(
                    code="evidence.test_notes",
                    title="Testing evidence",
                    severity="info",
                    status="passed",
                    summary="Submitter testing notes were provided",
                    evidence=[test_notes.strip()[:500]],
                )
            )
        checks.extend(
            [
                PublicationCheckResult(
                    code="compatibility.windows_native",
                    title="Windows native compatibility",
                    severity="info",
                    status="not_run",
                    summary="Runs in the GitLab MR pipeline on a native Windows runner",
                    evidence=[],
                    execution_environment="gitlab/windows",
                ),
                PublicationCheckResult(
                    code="compatibility.macos_native",
                    title="macOS native compatibility",
                    severity="info",
                    status="not_run",
                    summary="Runs in the GitLab MR pipeline on a native macOS runner",
                    evidence=[],
                    execution_environment="gitlab/macos",
                ),
            ]
        )
        return PublicationInspection(
            parsed=parsed,
            security_report=security_report,
            checks=checks,
            detected_risks=detected_risks,
        )

    def _command_declaration_check(
        self,
        *,
        detected: bool,
        declared: bool,
        executable_paths: list[str],
        runtime_components: list[str],
    ) -> PublicationCheckResult:
        evidence = [*executable_paths[:50], *runtime_components[:50]]
        if detected and not declared:
            return PublicationCheckResult(
                code="risk.command_declaration",
                title="Command and executable declaration",
                severity="blocker",
                status="blocked",
                summary="Executable capabilities were detected but not declared",
                evidence=evidence,
            )
        if detected:
            return PublicationCheckResult(
                code="risk.command_declaration",
                title="Command and executable declaration",
                severity="warning",
                status="warning",
                summary=(
                    "Declared executable capabilities require admin acknowledgement"
                ),
                evidence=evidence,
                acknowledgement_required=True,
            )
        return PublicationCheckResult(
            code="risk.command_declaration",
            title="Command and executable declaration",
            severity="info",
            status="passed",
            summary="No executable capabilities were detected",
            evidence=[],
        )

    def _declared_risk_checks(
        self, declaration: dict[str, Any]
    ) -> list[PublicationCheckResult]:
        specs = (
            (
                "risk.external_network",
                "External network access",
                "externalNetworkAccess",
                list(declaration.get("externalDomains") or []),
            ),
            (
                "risk.local_files",
                "Local file access",
                "readsOrWritesLocalFiles",
                [],
            ),
            ("risk.credentials", "Credential use", "usesCredentials", []),
            (
                "risk.application_permissions",
                "Application permissions",
                "applicationPermissions",
                list(declaration.get("applicationPermissions") or []),
            ),
        )
        results: list[PublicationCheckResult] = []
        for code, title, key, evidence in specs:
            declared = bool(declaration.get(key))
            if key == "applicationPermissions":
                declared = bool(evidence)
            results.append(
                PublicationCheckResult(
                    code=code,
                    title=title,
                    severity="warning" if declared else "info",
                    status="warning" if declared else "passed",
                    summary=(
                        "Declared by the submitter and requires acknowledgement"
                        if declared
                        else "Not declared"
                    ),
                    evidence=[str(item)[:500] for item in evidence[:100]],
                    acknowledgement_required=declared,
                )
            )
        return results


plugin_publication_check_service = PluginPublicationCheckService()
