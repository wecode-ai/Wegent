# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for ModelAggregationService.

Focuses on testing model compatibility filtering for custom shells.
"""

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.services.adapters.public_model import ModelAdapter
from app.services.model_aggregation_service import (
    ModelType,
    UnifiedModel,
    build_model_runtime_family,
    model_aggregation_service,
)
from app.services.user_runtime_config import user_runtime_config_service


class TestModelAggregationService:
    """Tests for model_aggregation_service methods."""

    def test_wework_lists_runtime_codex_model_when_user_auth_enabled(
        self, test_db: Session, test_user: User, monkeypatch
    ):
        """Wework should see a runtime-only Codex GPT model after auth is enabled."""
        monkeypatch.setattr(
            "app.services.model_aggregation_service.kind_service.list_resources",
            lambda user_id, kind, namespace: [],
        )
        user_runtime_config_service.save_auth_json(
            test_db,
            user_id=test_user.id,
            runtime="codex",
            auth_json='{"token":"secret"}',
        )
        user_runtime_config_service.set_use_user_config(
            test_db,
            user=test_user,
            runtime="codex",
            use_user_config=True,
        )
        test_db.refresh(test_user)

        models = model_aggregation_service.list_available_models(
            db=test_db,
            current_user=test_user,
            scope="all",
            model_category_type="llm",
            client_origin="wework",
        )

        runtime_model = next(
            model for model in models if model["name"] == "codex-gpt-5.5"
        )
        assert runtime_model["type"] == "runtime"
        assert runtime_model["provider"] == "openai"
        assert runtime_model["modelId"] == "gpt-5.5"
        assert runtime_model["runtime"] == {
            "family": "openai.openai-responses",
            "provider": "openai",
        }
        assert runtime_model["config"] == {
            "protocol": "openai-responses",
            "apiFormat": "responses",
            "ui": {
                "family": "gpt",
                "modelLabel": "GPT-5.5",
                "controls": ["speed"],
                "sortOrder": 10,
            },
        }

    def test_runtime_codex_model_is_hidden_outside_wework(
        self, test_db: Session, test_user: User, monkeypatch
    ):
        """The runtime-only Codex model must not leak into normal Wegent model lists."""
        monkeypatch.setattr(
            "app.services.model_aggregation_service.kind_service.list_resources",
            lambda user_id, kind, namespace: [],
        )
        user_runtime_config_service.save_auth_json(
            test_db,
            user_id=test_user.id,
            runtime="codex",
            auth_json='{"token":"secret"}',
        )
        user_runtime_config_service.set_use_user_config(
            test_db,
            user=test_user,
            runtime="codex",
            use_user_config=True,
        )
        test_db.refresh(test_user)

        models = model_aggregation_service.list_available_models(
            db=test_db,
            current_user=test_user,
            scope="all",
            model_category_type="llm",
        )

        assert all(model["name"] != "codex-gpt-5.5" for model in models)

    def test_resolves_runtime_codex_model_by_explicit_type_when_user_auth_enabled(
        self, test_db: Session, test_user: User
    ):
        """Runtime Codex model details should resolve for send/detail flows."""
        user_runtime_config_service.save_auth_json(
            test_db,
            user_id=test_user.id,
            runtime="codex",
            auth_json='{"token":"secret"}',
        )
        user_runtime_config_service.set_use_user_config(
            test_db,
            user=test_user,
            runtime="codex",
            use_user_config=True,
        )
        test_db.refresh(test_user)

        model = model_aggregation_service.resolve_model(
            db=test_db,
            current_user=test_user,
            name="codex-gpt-5.5",
            model_type="runtime",
        )

        assert model is not None
        assert model["type"] == "runtime"
        assert model["provider"] == "openai"
        assert model["modelId"] == "gpt-5.5"
        assert model["config"] == {
            "protocol": "openai-responses",
            "apiFormat": "responses",
            "ui": {
                "family": "gpt",
                "modelLabel": "GPT-5.5",
                "controls": ["speed"],
                "sortOrder": 10,
            },
        }

    def test_extract_model_info_includes_custom_group_fields(self):
        """Test Model.spec grouping fields are exposed by aggregation metadata."""
        model_crd = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Model",
            "metadata": {"name": "generic-model", "namespace": "default"},
            "spec": {
                "modelConfig": {
                    "env": {
                        "model": "openai",
                        "model_id": "generic-model-id",
                        "api_key": "secret",
                    }
                },
                "modelGroup": "Primary Group",
                "modelSubGroup": "Secondary Group",
            },
            "status": {"state": "Available"},
        }

        info = model_aggregation_service._extract_model_info_from_crd(model_crd)

        assert info["model_group"] == "Primary Group"
        assert info["model_sub_group"] == "Secondary Group"
        assert info["provider"] == "openai"

    def test_unified_model_exposes_runtime_family_without_env(self):
        """Test API model data exposes runtime family without sensitive env."""
        unified = UnifiedModel(
            name="openai-gpt-5.4",
            model_type=ModelType.PUBLIC,
            provider="openai",
            model_id="gpt-5.4",
            resource_user_id=0,
            config={
                "env": {
                    "model": "openai",
                    "model_id": "gpt-5.4",
                    "api_key": "secret",
                },
                "protocol": "openai-responses",
            },
        )

        model_dict = unified.to_dict()
        full_model_dict = unified.to_full_dict()

        assert model_dict["runtime"] == {
            "family": "openai.openai-responses",
            "provider": "openai",
        }
        assert "env" not in model_dict["config"]
        assert "env" not in full_model_dict["config"]
        assert model_dict["resourceUserId"] == 0
        assert full_model_dict["resourceUserId"] == 0
        assert full_model_dict["runtime"] == {
            "family": "openai.openai-responses",
            "provider": "openai",
        }
        assert full_model_dict["config"] == {"protocol": "openai-responses"}

    def test_runtime_family_falls_back_to_provider_without_protocol(self):
        """Test runtime family remains provider-only when spec.protocol is absent."""
        assert (
            build_model_runtime_family("openai", {"apiFormat": "responses"}) == "openai"
        )
        assert build_model_runtime_family(" Claude ", {"protocol": " claude "}) == (
            "claude.claude"
        )
        assert (
            build_model_runtime_family(None, {"protocol": "openai-responses"}) is None
        )

    def test_public_model_adapter_exposes_protocol_without_env(self):
        """Test public model adapter preserves spec.protocol for runtime family."""
        model_crd = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Model",
            "metadata": {
                "name": "openai-gpt-5.4",
                "namespace": "default",
                "displayName": "海外:GPT5.4",
            },
            "spec": {
                "protocol": "openai-responses",
                "apiFormat": "responses",
                "modelConfig": {
                    "env": {
                        "model": "openai",
                        "model_id": "gpt-5.4",
                        "api_key": "secret",
                    }
                },
            },
            "status": {"state": "Available"},
        }
        kind = Kind(
            user_id=0,
            kind="Model",
            name="openai-gpt-5.4",
            namespace="default",
            json=model_crd,
            is_active=True,
        )

        model_dict = ModelAdapter.to_model_dict(kind)

        assert model_dict["provider"] == "openai"
        assert model_dict["model_id"] == "gpt-5.4"
        assert model_dict["config"]["protocol"] == "openai-responses"
        assert model_dict["config"]["apiFormat"] == "responses"
        assert model_dict["config"]["env"] == {}

    def _create_public_shell(
        self,
        db: Session,
        name: str,
        shell_type: str,
        support_model: list = None,
    ) -> Kind:
        """Helper to create a public shell."""
        shell_crd = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Shell",
            "metadata": {
                "name": name,
                "namespace": "default",
                "labels": {"type": "local_engine"},
            },
            "spec": {
                "shellType": shell_type,
                "supportModel": support_model or [],
                "baseImage": "test-image:latest",
            },
            "status": {"state": "Available"},
        }
        shell = Kind(
            user_id=0,  # Public shell
            kind="Shell",
            name=name,
            namespace="default",
            json=shell_crd,
            is_active=True,
        )
        db.add(shell)
        db.commit()
        db.refresh(shell)
        return shell

    def _create_custom_shell(
        self,
        db: Session,
        user: User,
        name: str,
        base_shell_ref: str,
        shell_type: str,
        support_model: list = None,
        namespace: str = "default",
    ) -> Kind:
        """Helper to create a user-defined custom shell."""
        shell_crd = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Shell",
            "metadata": {
                "name": name,
                "namespace": namespace,
                "labels": {"type": "local_engine"},
            },
            "spec": {
                "shellType": shell_type,  # Inherited from base shell
                "supportModel": support_model or [],
                "baseImage": "custom-image:latest",
                "baseShellRef": base_shell_ref,
            },
            "status": {"state": "Available"},
        }
        shell = Kind(
            user_id=user.id,
            kind="Shell",
            name=name,
            namespace=namespace,
            json=shell_crd,
            is_active=True,
        )
        db.add(shell)
        db.commit()
        db.refresh(shell)
        return shell

    def test_get_shell_support_model_public_shell(
        self, test_db: Session, test_user: User
    ):
        """Test _get_shell_support_model returns correct data for public shell."""
        # Create a public shell with specific support_model
        self._create_public_shell(test_db, "ClaudeCode", "ClaudeCode", support_model=[])

        support_model, shell_type = model_aggregation_service._get_shell_support_model(
            test_db, "ClaudeCode", test_user
        )

        assert shell_type == "ClaudeCode"
        assert support_model == []

    def test_get_shell_support_model_custom_shell(
        self, test_db: Session, test_user: User
    ):
        """Test _get_shell_support_model returns inherited shellType for custom shell."""
        # Create base public shell
        self._create_public_shell(test_db, "ClaudeCode", "ClaudeCode", support_model=[])

        # Create custom shell based on ClaudeCode
        self._create_custom_shell(
            test_db,
            test_user,
            "my-custom-claude",
            "ClaudeCode",
            "ClaudeCode",  # Inherited shellType
            support_model=[],
        )

        support_model, shell_type = model_aggregation_service._get_shell_support_model(
            test_db, "my-custom-claude", test_user
        )

        # Custom shell should return the inherited shellType
        assert shell_type == "ClaudeCode"

    def test_get_shell_support_model_not_found(self, test_db: Session, test_user: User):
        """Test _get_shell_support_model returns shell_name when not found."""
        support_model, shell_type = model_aggregation_service._get_shell_support_model(
            test_db, "non-existent-shell", test_user
        )

        # When shell not found, should return empty list and the shell_name as type
        assert support_model == []
        assert shell_type == "non-existent-shell"

    def test_is_model_compatible_with_shell_claudecode(self, test_db: Session):
        """Test model compatibility for ClaudeCode shell type."""
        # ClaudeCode keeps Claude support and routes OpenAI Responses models to CodeX.
        assert model_aggregation_service._is_model_compatible_with_shell(
            "claude", "ClaudeCode", []
        )
        assert model_aggregation_service._is_model_compatible_with_shell(
            "openai", "ClaudeCode", [], {"apiFormat": "responses"}
        )
        assert model_aggregation_service._is_model_compatible_with_shell(
            "openai", "ClaudeCode", [], {"protocol": "openai-responses"}
        )
        assert not model_aggregation_service._is_model_compatible_with_shell(
            "openai", "ClaudeCode", [], {"apiFormat": "chat/completions"}
        )
        assert not model_aggregation_service._is_model_compatible_with_shell(
            "openai", "ClaudeCode", ["openai"], {"apiFormat": "chat/completions"}
        )
        assert not model_aggregation_service._is_model_compatible_with_shell(
            "gemini", "ClaudeCode", []
        )

    def test_is_model_compatible_with_shell_agno(self, test_db: Session):
        """Test model compatibility for Agno shell type."""
        # Agno supports OpenAI, Claude, and Gemini models
        assert model_aggregation_service._is_model_compatible_with_shell(
            "claude", "Agno", []
        )
        assert model_aggregation_service._is_model_compatible_with_shell(
            "openai", "Agno", []
        )
        assert model_aggregation_service._is_model_compatible_with_shell(
            "gemini", "Agno", []
        )

    def test_is_model_compatible_with_custom_support_model(self, test_db: Session):
        """Test model compatibility with custom supportModel list."""
        # When supportModel is specified, it overrides the default mapping
        assert model_aggregation_service._is_model_compatible_with_shell(
            "claude", "SomeShell", ["claude", "openai"]
        )
        assert model_aggregation_service._is_model_compatible_with_shell(
            "openai", "SomeShell", ["claude", "openai"]
        )
        assert not model_aggregation_service._is_model_compatible_with_shell(
            "gemini", "SomeShell", ["claude", "openai"]
        )

    def test_custom_shell_inherits_model_filter_from_base(
        self, test_db: Session, test_user: User
    ):
        """
        Test that custom shells correctly inherit model filtering from base shell type.

        This is the main bug being fixed:
        - Custom shell "my-custom-claude" is based on ClaudeCode
        - It should only allow Claude models, not all models
        """
        # Create base public shell
        self._create_public_shell(test_db, "ClaudeCode", "ClaudeCode", support_model=[])

        # Create custom shell based on ClaudeCode
        self._create_custom_shell(
            test_db,
            test_user,
            "my-custom-claude",
            "ClaudeCode",
            "ClaudeCode",
            support_model=[],
        )

        # Get support_model and shell_type for custom shell
        support_model, shell_type = model_aggregation_service._get_shell_support_model(
            test_db, "my-custom-claude", test_user
        )

        # Verify shell_type is inherited as ClaudeCode
        assert shell_type == "ClaudeCode"

        # Verify model compatibility uses the inherited shell type
        # Claude should be allowed
        assert model_aggregation_service._is_model_compatible_with_shell(
            "claude", shell_type, support_model
        )
        # OpenAI should only be allowed when it uses the Responses API for CodeX.
        assert not model_aggregation_service._is_model_compatible_with_shell(
            "openai", shell_type, support_model, {"apiFormat": "chat/completions"}
        )
        assert model_aggregation_service._is_model_compatible_with_shell(
            "openai", shell_type, support_model, {"apiFormat": "responses"}
        )
        # Gemini should NOT be allowed for ClaudeCode type
        assert not model_aggregation_service._is_model_compatible_with_shell(
            "gemini", shell_type, support_model
        )

    def test_custom_shell_agno_allows_multiple_providers(
        self, test_db: Session, test_user: User
    ):
        """Test that custom Agno shells correctly allow multiple model providers."""
        # Create base public shell
        self._create_public_shell(test_db, "Agno", "Agno", support_model=[])

        # Create custom shell based on Agno
        self._create_custom_shell(
            test_db,
            test_user,
            "my-custom-agno",
            "Agno",
            "Agno",
            support_model=[],
        )

        # Get support_model and shell_type for custom shell
        support_model, shell_type = model_aggregation_service._get_shell_support_model(
            test_db, "my-custom-agno", test_user
        )

        # Verify shell_type is inherited as Agno
        assert shell_type == "Agno"

        # Agno should allow all three providers
        assert model_aggregation_service._is_model_compatible_with_shell(
            "claude", shell_type, support_model
        )
        assert model_aggregation_service._is_model_compatible_with_shell(
            "openai", shell_type, support_model
        )
        assert model_aggregation_service._is_model_compatible_with_shell(
            "gemini", shell_type, support_model
        )

    def test_get_shell_support_model_with_group_shell(
        self, test_db: Session, test_user: User
    ):
        """Test _get_shell_support_model with a group shell."""
        from unittest.mock import patch

        with patch(
            "app.services.group_permission.get_user_groups",
            return_value=["test-group"],
        ):
            # Create a group shell
            shell_crd = {
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Shell",
                "metadata": {
                    "name": "group-shell",
                    "namespace": "test-group",
                    "labels": {"type": "local_engine"},
                },
                "spec": {
                    "shellType": "Agno",
                    "supportModel": ["claude", "openai"],
                    "baseImage": "test-image:latest",
                },
                "status": {"state": "Available"},
            }
            shell = Kind(
                user_id=999,  # Different user
                kind="Shell",
                name="group-shell",
                namespace="test-group",
                json=shell_crd,
                is_active=True,
            )
            test_db.add(shell)
            test_db.commit()

            # Get support_model and shell_type for group shell
            support_model, shell_type = (
                model_aggregation_service._get_shell_support_model(
                    test_db, "group-shell", test_user
                )
            )

            assert shell_type == "Agno"
            assert set(support_model) == {"claude", "openai"}

    def test_get_shell_support_model_public_shell_in_non_default_namespace(
        self, test_db: Session, test_user: User
    ):
        """Test _get_shell_support_model finds public shells in non-default namespaces."""
        # Create a public shell in non-default namespace
        shell_crd = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Shell",
            "metadata": {
                "name": "CustomPublicShell",
                "namespace": "custom-ns",
                "labels": {"type": "local_engine"},
            },
            "spec": {
                "shellType": "CustomType",
                "supportModel": ["custom-provider"],
                "baseImage": "test-image:latest",
            },
            "status": {"state": "Available"},
        }
        shell = Kind(
            user_id=0,  # Public shell
            kind="Shell",
            name="CustomPublicShell",
            namespace="custom-ns",  # Non-default namespace
            json=shell_crd,
            is_active=True,
        )
        test_db.add(shell)
        test_db.commit()

        # Should find the shell even in non-default namespace
        support_model, shell_type = model_aggregation_service._get_shell_support_model(
            test_db, "CustomPublicShell", test_user
        )

        assert shell_type == "CustomType"
        assert support_model == ["custom-provider"]

    def test_get_shell_support_model_with_support_model_list(
        self, test_db: Session, test_user: User
    ):
        """Test _get_shell_support_model correctly parses supportModel list."""
        # Create a shell with specific supportModel
        self._create_public_shell(
            test_db,
            "MultiProviderShell",
            "MultiProvider",
            support_model=["claude", "openai", "gemini"],
        )

        support_model, shell_type = model_aggregation_service._get_shell_support_model(
            test_db, "MultiProviderShell", test_user
        )

        assert shell_type == "MultiProvider"
        assert set(support_model) == {"claude", "openai", "gemini"}

    def test_get_shell_support_model_precedence_order(
        self, test_db: Session, test_user: User
    ):
        """Test that shell lookup follows correct precedence: public > personal > group."""
        from unittest.mock import patch

        # Create shells with same name in different scopes
        # 1. Public shell
        self._create_public_shell(
            test_db,
            "SharedShellName",
            "PublicType",
            support_model=["public-provider"],
        )

        # 2. Personal shell
        self._create_custom_shell(
            test_db,
            test_user,
            "SharedShellName",
            "PublicType",
            "PersonalType",
            support_model=["personal-provider"],
        )

        # The function should return the public shell (precedence)
        support_model, shell_type = model_aggregation_service._get_shell_support_model(
            test_db, "SharedShellName", test_user
        )

        assert shell_type == "PublicType"  # From public shell
        assert support_model == ["public-provider"]  # From public shell
