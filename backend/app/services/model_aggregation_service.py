# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unified Model Aggregation Service

This service provides a unified interface for querying models from both:
- Public models (user_id=0 in kinds table)
- User-defined models (via kind_service)

It also handles model type differentiation to avoid naming conflicts.
"""

import logging
from enum import Enum
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.schemas.kind import Model, ModelCategoryType, Shell
from app.services.adapters.public_model import public_model_service
from app.services.adapters.shell_utils import find_shell_json
from app.services.kind import kind_service

logger = logging.getLogger(__name__)


class ModelType(str, Enum):
    """
    Model type enumeration.

    - PUBLIC: Models from kinds table with user_id=0, shared across all users
    - USER: User-defined models from kinds table, private to each user
    - GROUP: Models from kinds table in group namespace, shared within group
    """

    PUBLIC = "public"
    USER = "user"
    GROUP = "group"


class UnifiedModel:
    """
    Unified model representation that includes type information
    to distinguish between public, user-defined, and group models.

    The 'type' field is critical for:
    1. Avoiding naming conflicts between public, user, and group models
    2. Determining which table to query when resolving a model
    3. Frontend display differentiation
    """

    def __init__(
        self,
        name: str,
        model_type: ModelType,
        display_name: Optional[str] = None,
        provider: Optional[str] = None,
        model_id: Optional[str] = None,
        config: Optional[Dict[str, Any]] = None,
        is_active: bool = True,
        namespace: str = "default",
        model_category_type: Optional[
            str
        ] = None,  # New: llm, tts, stt, embedding, rerank
    ):
        self.name = name
        self.type = (
            model_type  # 'public' or 'user' or 'group' - identifies model source
        )
        self.display_name = display_name
        self.provider = provider
        self.model_id = model_id
        self.config = config or {}
        self.is_active = is_active
        self.namespace = namespace  # Resource namespace (group name or 'default')
        self.model_category_type = (
            model_category_type or "llm"
        )  # Default to 'llm' for backward compatibility

    def to_dict(self) -> Dict[str, Any]:
        """
        Convert to dictionary for API response.

        Returns dict with:
        - name: Model name
        - type: 'public', 'user', or 'group' - IMPORTANT for identifying model source
        - displayName: Human-readable name
        - provider: Model provider (e.g., 'openai', 'claude')
        - modelId: Model ID
        - namespace: Resource namespace (group name or 'default')
        - modelCategoryType: Model category type (llm, tts, stt, embedding, rerank)
        """
        return {
            "name": self.name,
            "type": self.type.value,  # 'public', 'user', or 'group'
            "displayName": self.display_name,
            "provider": self.provider,
            "modelId": self.model_id,
            "namespace": self.namespace,
            "modelCategoryType": self.model_category_type,  # New field
        }

    def to_full_dict(self) -> Dict[str, Any]:
        """Convert to full dictionary including config"""
        result = self.to_dict()
        result["config"] = self.config
        result["isActive"] = self.is_active
        return result


class ModelAggregationService:
    """
    Service for aggregating models from multiple sources.

    This service provides:
    1. Unified model listing with type information
    2. Model lookup by name and type
    3. Agent-compatible model filtering

    All returned models include a 'type' field ('public', 'user', or 'group')
    to distinguish their source and avoid naming conflicts.
    """

    def _extract_model_info_from_crd(
        self, model_data: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Extract model information from CRD format data.

        Returns:
            Dict with keys: provider, model_id, display_name, config, model_category_type
        """
        if not isinstance(model_data, dict):
            return {
                "provider": None,
                "model_id": None,
                "display_name": None,
                "config": {},
                "model_category_type": "llm",
            }

        try:
            model_crd = Model.model_validate(model_data)
            env = model_crd.spec.modelConfig.get("env", {})
            if not isinstance(env, dict):
                env = {}

            # Extract model category type (defaults to 'llm' for backward compatibility)
            model_category_type = "llm"
            if model_crd.spec.modelType:
                model_category_type = model_crd.spec.modelType.value

            return {
                "provider": env.get("model"),
                "model_id": env.get("model_id"),
                "display_name": model_crd.metadata.displayName,
                "config": model_crd.spec.modelConfig,
                "model_category_type": model_category_type,
            }
        except (ValueError, KeyError, AttributeError) as e:
            logger.warning("Failed to extract model info: %s", e)
            return {
                "provider": None,
                "model_id": None,
                "display_name": None,
                "config": {},
                "model_category_type": "llm",
            }

    def _is_model_compatible_with_shell(
        self, provider: Optional[str], shell_type: str, support_model: List[str]
    ) -> bool:
        """
        Check if a model is compatible with the given shell type.

        Args:
            provider: Model provider (e.g., 'openai', 'claude')
            shell_type: Shell type (e.g., 'Agno', 'ClaudeCode')
            support_model: List of supported model providers from shell spec

        Returns:
            True if compatible, False otherwise
        """
        # Shell type to model provider mapping
        # Agno supports OpenAI, Claude and Gemini models
        shell_provider_map = {
            "Agno": ["openai", "claude", "gemini"],
            "ClaudeCode": ["claude"],
        }

        # If supportModel is specified in shell, use it
        if support_model:
            return provider in support_model

        # Otherwise, filter by shell's supported providers
        supported_providers = shell_provider_map.get(shell_type)
        if supported_providers:
            if isinstance(supported_providers, list):
                return provider in supported_providers
            else:
                return provider == supported_providers

        # No filter, allow all
        return True

    def _get_shell_support_model(
        self, db: Session, shell_name: str, current_user: Optional[User] = None
    ) -> tuple[List[str], str]:
        """
        Get supported model list and shellType from shell configuration.

        Args:
            db: Database session
            shell_name: Shell name (can be public shell name or custom shell name)
            current_user: Current user (optional, for looking up user-defined shells)

        Returns:
            Tuple of (supported model list, shell type)
        """
        user_id = current_user.id if current_user else None
        shell_json = find_shell_json(db, shell_name, user_id)
        if not shell_json:
            return ([], shell_name)

        try:
            shell_crd = Shell.model_validate(shell_json)
            support_model = shell_crd.spec.supportModel or []
            return (
                [str(x) for x in support_model if x],
                shell_crd.spec.shellType,
            )
        except (ValueError, KeyError, AttributeError) as e:
            logger.warning("Failed to parse shell config: %s", e)
            return ([], shell_name)

    def _is_custom_model(self, model_data: Dict[str, Any]) -> bool:
        """
        Check if a model is a custom configuration model.

        Custom models have isCustomConfig=True in their spec and should not
        appear in the unified model list. They are user-specific configurations
        that are only used internally.

        Args:
            model_data: Model CRD data dictionary

        Returns:
            True if the model is a custom config model, False otherwise
        """
        if not isinstance(model_data, dict):
            return False

        try:
            model_crd = Model.model_validate(model_data)
            return model_crd.spec.isCustomConfig or False
        except (ValueError, KeyError, AttributeError) as e:
            logger.warning("Failed to check if model is custom: %s", e)
            return False

    def list_available_models(
        self,
        db: Session,
        current_user: User,
        shell_type: Optional[str] = None,
        include_config: bool = False,
        scope: str = "personal",
        group_name: Optional[str] = None,
        model_category_type: Optional[str] = None,  # New: filter by model category type
    ) -> List[Dict[str, Any]]:
        """
        List all available models for the current user with scope support.

        This method aggregates models from:
        1. User's own models (via kind_service) - marked with type='user'
        2. Public models (user_id=0 in kinds table) - marked with type='public'
        3. Group models (when scope includes groups) - marked with type='group'

        Scope behavior:
        - scope='personal' (default): personal models + public models
        - scope='group': group models + public models (requires group_name)
        - scope='all': personal + public + all user's groups

        Each returned model includes a 'type' field to identify its source.

        Args:
            db: Database session
            current_user: Current user
            shell_type: Optional shell type to filter compatible models
            include_config: Whether to include full config in response
            scope: Query scope ('personal', 'group', or 'all')
            group_name: Group name (required when scope='group')
            model_category_type: Optional model category type filter (llm, tts, stt, embedding, rerank)

        Returns:
            List of unified model dictionaries, each containing:
            - name: Model name
            - type: 'public', 'user', or 'group' (identifies model source)
            - displayName: Human-readable name
            - provider: Model provider
            - modelId: Model ID
            - modelCategoryType: Model category type (llm, tts, stt, embedding, rerank)
        """
        from app.services.group_permission import get_user_groups

        support_model: List[str] = []
        actual_shell_type: str = shell_type or ""
        if shell_type:
            support_model, actual_shell_type = self._get_shell_support_model(
                db, shell_type, current_user
            )

        result: List[UnifiedModel] = []
        seen_names: Dict[str, ModelType] = {}  # Track names to handle duplicates

        # Determine which namespaces to query based on scope
        namespaces_to_query = []

        if scope == "personal":
            # Personal models only
            namespaces_to_query = ["default"]
        elif scope == "group":
            # Group models - if group_name not provided, query all user's groups
            if group_name:
                namespaces_to_query = [group_name]
            else:
                # Query all user's groups (excluding default)
                user_groups = get_user_groups(db, current_user.id)
                namespaces_to_query = user_groups if user_groups else []
        elif scope == "all":
            # Personal + all user's groups
            namespaces_to_query = ["default"] + get_user_groups(db, current_user.id)
        else:
            raise ValueError(f"Invalid scope: {scope}")

        # 1. Get user models from specified namespaces
        # Note: Only include non-custom models (isCustomConfig != True)
        # Custom models are user-specific configurations that should not appear in unified list
        for namespace in namespaces_to_query:
            if namespace == "default":
                # Query personal models
                user_model_resources = kind_service.list_resources(
                    user_id=current_user.id, kind="Model", namespace="default"
                )
                resource_type = ModelType.USER  # Personal models
            else:
                # Query group models (namespace = group_name, user_id can be any member)
                group_model_resources = (
                    db.query(Kind)
                    .filter(
                        Kind.kind == "Model",
                        Kind.namespace == namespace,
                        Kind.is_active == True,
                    )
                    .all()
                )
                user_model_resources = group_model_resources
                resource_type = ModelType.GROUP  # Group models

            for resource in user_model_resources:
                # Format the resource to get the full CRD data
                model_data = kind_service._format_resource("Model", resource)

                # Skip custom config models - they should not appear in unified list
                # Custom models are user-specific configurations (isCustomConfig=True)
                if self._is_custom_model(model_data):
                    continue
                info = self._extract_model_info_from_crd(model_data)

                if shell_type and not self._is_model_compatible_with_shell(
                    info["provider"], actual_shell_type, support_model
                ):
                    continue

                # Filter by model category type if specified
                if (
                    model_category_type
                    and info.get("model_category_type", "llm") != model_category_type
                ):
                    continue

                # Deduplicate by name
                if resource.name in seen_names:
                    continue

                unified = UnifiedModel(
                    name=resource.name,
                    model_type=resource_type,  # Use determined type (USER or GROUP)
                    display_name=info["display_name"],
                    provider=info["provider"],
                    model_id=info["model_id"],
                    config=info["config"] if include_config else {},
                    is_active=resource.is_active,
                    namespace=resource.namespace,
                    model_category_type=info.get("model_category_type", "llm"),
                )
                result.append(unified)
                seen_names[resource.name] = resource_type

        # 2. Get public models via public_model_service (type='public')
        public_models = public_model_service.get_models(
            db=db,
            skip=0,
            limit=1000,  # Get all public models
            current_user=current_user,
        )

        for model_dict in public_models:
            # public_model_service.get_models returns dict with 'config' and 'displayName' keys
            config = model_dict.get("config", {})
            env = config.get("env", {}) if isinstance(config, dict) else {}

            provider = env.get("model") if isinstance(env, dict) else None
            model_id = env.get("model_id") if isinstance(env, dict) else None

            # Extract model category type from public model data
            public_model_category_type = "llm"  # Default for backward compatibility
            if isinstance(config, dict):
                public_model_category_type = config.get("modelType", "llm")

            if shell_type and not self._is_model_compatible_with_shell(
                provider, actual_shell_type, support_model
            ):
                continue

            # Filter by model category type if specified
            if (
                model_category_type
                and public_model_category_type != model_category_type
            ):
                continue

            unified = UnifiedModel(
                name=model_dict.get("name", ""),
                model_type=ModelType.PUBLIC,  # Mark as public model
                display_name=model_dict.get(
                    "displayName"
                ),  # Get displayName from model dict
                provider=provider,
                model_id=model_id,
                is_active=model_dict.get("is_active", True),
                namespace="default",
                model_category_type=public_model_category_type,
            )

            # If name already exists as user model, we still add public model
            # The type field will differentiate them
            model_name = model_dict.get("name", "")
            if model_name in seen_names:
                logger.debug(
                    f"Model name '{model_name}' exists in both user and public models"
                )

            result.append(unified)
            if model_name not in seen_names:
                seen_names[model_name] = ModelType.PUBLIC

        # Sort by name
        result.sort(key=lambda x: x.name)

        # Convert to dict - each dict will have 'type' field
        if include_config:
            return [m.to_full_dict() for m in result]
        return [m.to_dict() for m in result]

    def get_model_by_name_and_type(
        self, db: Session, current_user: User, name: str, model_type: ModelType
    ) -> Optional[Dict[str, Any]]:
        """
        Get a specific model by name and type.

        The type parameter is required to avoid ambiguity when
        both public and user models have the same name.

        Args:
            db: Database session
            current_user: Current user
            name: Model name
            model_type: Model type ('public' or 'user')

        Returns:
            Model data dictionary with 'type' field, or None if not found
        """
        if model_type == ModelType.USER:
            resource = kind_service.get_resource(
                user_id=current_user.id, kind="Model", namespace="default", name=name
            )

            if resource:
                model_data = kind_service._format_resource("Model", resource)
                info = self._extract_model_info_from_crd(model_data)

                return UnifiedModel(
                    name=resource.name,
                    model_type=ModelType.USER,
                    display_name=info["display_name"],
                    provider=info["provider"],
                    model_id=info["model_id"],
                    config=info["config"],
                    is_active=resource.is_active,
                ).to_full_dict()

        elif model_type == ModelType.PUBLIC:
            # Get all public models and find by name
            public_models = public_model_service.get_models(
                db=db, skip=0, limit=1000, current_user=current_user
            )

            for model_dict in public_models:
                if model_dict.get("name") == name:
                    config = model_dict.get("config", {})
                    env = config.get("env", {}) if isinstance(config, dict) else {}

                    return UnifiedModel(
                        name=model_dict.get("name", ""),
                        model_type=ModelType.PUBLIC,
                        display_name=None,
                        provider=env.get("model") if isinstance(env, dict) else None,
                        model_id=env.get("model_id") if isinstance(env, dict) else None,
                        is_active=model_dict.get("is_active", True),
                    ).to_full_dict()

        return None

    def resolve_model(
        self,
        db: Session,
        current_user: User,
        name: str,
        model_type: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Resolve a model by name, optionally with type hint.

        If model_type is not provided, it will try to find the model
        in the following order:
        1. User's own models (type='user')
        2. Public models (type='public')

        Args:
            db: Database session
            current_user: Current user
            name: Model name
            model_type: Optional model type hint ('public' or 'user')

        Returns:
            Model data dictionary with 'type' field, or None if not found
        """
        if model_type:
            try:
                mt = ModelType(model_type)
                return self.get_model_by_name_and_type(db, current_user, name, mt)
            except ValueError:
                logger.warning(f"Invalid model type: {model_type}")

        # Try user models first
        result = self.get_model_by_name_and_type(db, current_user, name, ModelType.USER)
        if result:
            return result

        # Then try public models
        return self.get_model_by_name_and_type(db, current_user, name, ModelType.PUBLIC)


# Singleton instance
model_aggregation_service = ModelAggregationService()
