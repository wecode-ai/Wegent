# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Local executor global capability synchronization."""

import json
import os
import shutil
from pathlib import Path
from typing import Any, Dict, Optional

from executor.services.api_client import SkillDownloader
from shared.logger import setup_logger

logger = setup_logger("local_capabilities")

DEFAULT_MANIFEST_PATH = Path.home() / ".wegent-executor" / "capabilities.json"
DEFAULT_SKILLS_DIR = Path.home() / ".claude" / "skills"


class GlobalCapabilityStore:
    """Persistent manifest for Wegent-managed global capabilities."""

    def __init__(
        self,
        *,
        manifest_path: Path = DEFAULT_MANIFEST_PATH,
        skills_dir: Path = DEFAULT_SKILLS_DIR,
    ) -> None:
        self.manifest_path = Path(manifest_path)
        self.skills_dir = Path(skills_dir)

    def load(self) -> Dict[str, Any]:
        """Load the manifest, returning an empty structure when absent."""
        if not self.manifest_path.exists():
            return {"skills": {}, "mcps": {}}
        try:
            data = json.loads(self.manifest_path.read_text())
        except Exception:
            logger.warning("Failed to read capability manifest, starting fresh")
            return {"skills": {}, "mcps": {}}
        if not isinstance(data, dict):
            return {"skills": {}, "mcps": {}}
        data.setdefault("skills", {})
        data.setdefault("mcps", {})
        return data

    def save(self, manifest: Dict[str, Any]) -> None:
        """Save the manifest atomically enough for local executor usage."""
        self.manifest_path.parent.mkdir(parents=True, exist_ok=True)
        self.manifest_path.write_text(
            json.dumps(manifest, indent=2, sort_keys=True),
        )

    def remove_stale_managed_skills(self, desired_names: set[str]) -> list[str]:
        """Remove previously managed skills missing from the replace payload."""
        manifest = self.load()
        logger.info(
            "Checking stale managed skills: manifest_skills=%s desired_skills=%s skills_dir=%s",
            sorted(manifest.get("skills", {}).keys()),
            sorted(desired_names),
            self.skills_dir,
        )
        removed = []
        for name, record in list(manifest.get("skills", {}).items()):
            managed = record.get("managed", True) if isinstance(record, dict) else False
            logger.info(
                "Stale skill candidate: name=%s managed=%s in_desired=%s path_exists=%s",
                name,
                managed,
                name in desired_names,
                (self.skills_dir / name).exists(),
            )
            if name in desired_names or not managed:
                continue
            skill_path = self.skills_dir / name
            if skill_path.exists() and self._is_child(skill_path, self.skills_dir):
                shutil.rmtree(skill_path)
                removed.append(name)
            manifest["skills"].pop(name, None)
        self.save(manifest)
        return removed

    def replace_records(
        self,
        *,
        skills: Dict[str, Dict[str, Any]],
        mcps: Dict[str, Dict[str, Any]],
    ) -> None:
        """Replace Wegent-managed manifest records with desired state."""
        old_manifest = self.load()
        logger.info(
            "Replacing capability manifest: old_skills=%s new_skills=%s old_mcps=%s new_mcps=%s",
            sorted(old_manifest.get("skills", {}).keys()),
            sorted(skills.keys()),
            sorted(old_manifest.get("mcps", {}).keys()),
            sorted(mcps.keys()),
        )
        self.save({"skills": skills, "mcps": mcps})

    def merge_records(
        self,
        *,
        skills: Dict[str, Dict[str, Any]],
        mcps: Dict[str, Dict[str, Any]],
    ) -> None:
        """Merge desired state into the existing manifest."""
        manifest = self.load()
        manifest.setdefault("skills", {}).update(skills)
        manifest.setdefault("mcps", {}).update(mcps)
        self.save(manifest)

    def _is_child(self, path: Path, parent: Path) -> bool:
        try:
            path.resolve().relative_to(parent.resolve())
            return True
        except ValueError:
            return False


class CapabilitySyncHandler:
    """Apply backend-requested capability sync payloads on the local device."""

    def __init__(
        self,
        *,
        auth_token: Optional[str] = None,
        store: Optional[GlobalCapabilityStore] = None,
        skills_dir: Path = DEFAULT_SKILLS_DIR,
    ) -> None:
        self.auth_token = auth_token or os.getenv("WEGENT_AUTH_TOKEN", "")
        self.skills_dir = Path(skills_dir)
        self.store = store or GlobalCapabilityStore(skills_dir=self.skills_dir)

    async def handle_sync_capabilities(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Socket.IO async handler for device:sync_capabilities."""
        return self.apply_sync(data)

    def apply_sync(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Apply a capability payload and return an acknowledgement dict."""
        mode = data.get("mode", "replace")
        if mode not in {"merge", "replace"}:
            return {"success": False, "error": f"unsupported sync mode: {mode}"}

        skills = data.get("skills") or []
        mcps = data.get("mcps") or []
        logger.info(
            "Applying capability sync: mode=%s skills=%s mcps=%s skill_names=%s mcp_names=%s",
            mode,
            len(skills),
            len(mcps),
            [item.get("name") for item in skills if isinstance(item, dict)],
            [item.get("name") for item in mcps if isinstance(item, dict)],
        )
        desired_skill_names = {
            item.get("name")
            for item in skills
            if isinstance(item, dict) and item.get("name")
        }

        removed = []
        if mode == "replace":
            removed = self.store.remove_stale_managed_skills(desired_skill_names)
            if removed:
                logger.info("Removed stale managed skills: %s", removed)

        skill_records = self._apply_skills(skills)
        mcp_records = self._build_mcp_records(mcps)

        if mode == "replace":
            self.store.replace_records(skills=skill_records, mcps=mcp_records)
        else:
            self.store.merge_records(skills=skill_records, mcps=mcp_records)

        result = {
            "success": True,
            "installed_skills": sorted(skill_records.keys()),
            "configured_mcps": sorted(mcp_records.keys()),
            "removed_skills": removed,
        }
        logger.info(
            "Capability sync applied: installed_skills=%s configured_mcps=%s removed_skills=%s",
            sorted(skill_records.keys()),
            sorted(mcp_records.keys()),
            removed,
        )
        return result

    def _apply_skills(self, skills: list[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
        records: Dict[str, Dict[str, Any]] = {}
        if not self.auth_token and skills:
            logger.warning("No auth token available, cannot sync global skills")
            return records

        self.skills_dir.mkdir(parents=True, exist_ok=True)
        downloader = SkillDownloader(
            auth_token=self.auth_token,
            team_namespace="default",
            skills_dir=str(self.skills_dir),
        )

        for item in skills:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            if not name:
                continue
            if (self.skills_dir / name).is_dir():
                records[name] = self._skill_record(name, item)
                logger.info("Global skill already present: %s", name)
                continue
            skill_ref = {
                "skill_id": item.get("skill_id"),
                "namespace": item.get("namespace", "default"),
            }
            if downloader._download_single_skill(name, skill_ref):
                records[name] = self._skill_record(name, item)
                logger.info("Installed global skill: %s", name)
            else:
                logger.warning("Failed to install global skill: %s", name)
        return records

    def _skill_record(self, name: str, item: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "name": name,
            "skill_id": item.get("skill_id"),
            "installed_skill_id": item.get("installed_skill_id"),
            "namespace": item.get("namespace", "default"),
            "managed": True,
        }

    def _build_mcp_records(
        self, mcps: list[Dict[str, Any]]
    ) -> Dict[str, Dict[str, Any]]:
        records: Dict[str, Dict[str, Any]] = {}
        for item in mcps:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            if not name:
                continue
            records[name] = {
                "name": name,
                "installed_mcp_id": item.get("installed_mcp_id"),
                "display_name": item.get("display_name") or item.get("displayName"),
                "description": item.get("description", ""),
                "source": item.get("source") or {},
                "server": item.get("server") or {},
                "managed": True,
            }
            logger.info("Configured global MCP: %s", name)
        return records
