# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
MCP Provider Data Mapper

Maps API responses to MCPServer objects based on configuration.
"""

from typing import Any, Dict, List, Optional

from app.schemas.mcp_provider_config import MCPProviderConfig
from app.schemas.mcp_providers import MCPServer
from shared.logger import setup_logger

logger = setup_logger("mcp_providers.mapper")


class DataMapper:
    """Maps API response data to MCPServer objects"""

    def map_servers(
        self,
        raw_items: List[Dict[str, Any]],
        config: MCPProviderConfig,
        token: str,
    ) -> List[MCPServer]:
        """Map raw API items to MCPServer objects"""
        servers = []

        for item in raw_items:
            server = self._map_server(item, config, token)
            if server:
                servers.append(server)

        return servers

    def _map_server(
        self,
        item: Dict[str, Any],
        config: MCPProviderConfig,
        token: str,
    ) -> Optional[MCPServer]:
        """Map a single raw item to MCPServer"""
        server_config = config.server

        # Extract ID
        raw_id = self._extract_field(item, server_config.id_field)
        if not raw_id:
            logger.warning("Skipping server without ID: %s", item)
            return None

        server_id = f"{server_config.id_prefix}{raw_id}"

        # Extract name
        name = self._extract_field(item, server_config.name_field)
        if not name:
            name = server_config.name_fallback
        if not name:
            name = "Unknown"

        # Extract description
        description = self._extract_optional(item, server_config.description_field)

        # Extract URL - try primary field first, then fallback
        url = self._extract_url(item, server_config)
        if not url:
            logger.warning("Skipping server %s without URL", server_id)
            return None

        # Extract type
        server_type = self._extract_optional(item, server_config.type_field)
        if not server_type:
            server_type = server_config.type_default

        # Extract provider
        provider = server_config.provider_static
        if not provider:
            provider = self._extract_optional(item, server_config.provider_field)
        if not provider:
            provider = config.name

        # Extract optional fields
        is_active = self._extract_bool(item, server_config.active_field, default=True)
        logo_url = self._extract_optional(item, server_config.logo_field)
        tags = self._extract_list(item, server_config.tags_field)

        # Build headers with auth
        headers = {"Authorization": f"Bearer {token}"}

        return MCPServer(
            id=server_id,
            name=name,
            description=description,
            type=server_type,
            base_url=url,
            command="",
            args=[],
            env={},
            headers=headers,
            is_active=is_active,
            provider=provider,
            provider_url=None,
            logo_url=logo_url,
            tags=tags,
        )

    def _extract_field(self, item: Dict[str, Any], field: str) -> Optional[str]:
        """Extract required string field"""
        value = self._extract_by_path(item, field)
        return str(value) if value is not None else None

    def _extract_optional(
        self, item: Dict[str, Any], field: Optional[str]
    ) -> Optional[str]:
        """Extract optional string field"""
        if not field:
            return None
        value = self._extract_by_path(item, field)
        return str(value) if value is not None else None

    def _extract_bool(
        self, item: Dict[str, Any], field: Optional[str], default: bool = False
    ) -> bool:
        """Extract boolean field"""
        if not field:
            return default
        value = self._extract_by_path(item, field)
        return bool(value) if value is not None else default

    def _extract_list(
        self, item: Dict[str, Any], field: Optional[str]
    ) -> Optional[List[str]]:
        """Extract list field"""
        if not field:
            return None
        value = self._extract_by_path(item, field)
        if isinstance(value, list):
            return [str(v) for v in value if v is not None]
        return None

    def _extract_url(self, item: Dict[str, Any], config: Any) -> Optional[str]:
        """Extract URL with support for array index and fallback"""
        # Try primary URL field
        url = self._extract_optional(item, config.url_field)
        if url:
            return url

        # Try fallback URL field
        if config.url_fallback:
            url = self._extract_optional(item, config.url_fallback)
            if url:
                return url

        # Try special handling for operational_urls array (ModelScope style)
        operational_urls = item.get("operational_urls")
        if (
            operational_urls
            and isinstance(operational_urls, list)
            and len(operational_urls) > 0
        ):
            first_url = operational_urls[0]
            if isinstance(first_url, dict):
                return first_url.get("url")

        return None

    def _extract_by_path(self, data: dict, path: str) -> Any:
        """Extract value by dot-notation path with array index support"""
        if not path:
            return data

        # Support formats: "data", "data.result", "operational_urls[0].url"
        parts = path.replace("[", ".").replace("]", "").split(".")

        current = data
        for part in parts:
            if isinstance(current, dict):
                current = current.get(part)
            elif isinstance(current, list):
                try:
                    idx = int(part)
                    current = current[idx] if 0 <= idx < len(current) else None
                except (ValueError, IndexError):
                    return None
            else:
                return None

            if current is None:
                return None

        return current
