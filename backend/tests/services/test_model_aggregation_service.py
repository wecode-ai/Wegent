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
from app.services.model_aggregation_service import model_aggregation_service


class TestModelAggregationService:
    """Tests for model_aggregation_service methods."""

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
        # ClaudeCode only supports Claude models
        assert model_aggregation_service._is_model_compatible_with_shell(
            "claude", "ClaudeCode", []
        )
        assert not model_aggregation_service._is_model_compatible_with_shell(
            "openai", "ClaudeCode", []
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
        # OpenAI should NOT be allowed for ClaudeCode type
        assert not model_aggregation_service._is_model_compatible_with_shell(
            "openai", shell_type, support_model
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
