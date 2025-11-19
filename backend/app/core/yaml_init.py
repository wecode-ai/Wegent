# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
YAML initialization module for loading initial data from YAML files.
This replaces the SQL-based initialization approach.
"""

import os
import logging
from typing import List, Dict, Any
from pathlib import Path
import yaml
from sqlalchemy.orm import Session

from app.models.user import User
from app.models.kind import Kind
from app.models.public_shell import PublicShell
from app.models.public_model import PublicModel

logger = logging.getLogger(__name__)


class YAMLInitializer:
    """Handle initialization from YAML configuration files."""

    def __init__(self, init_data_dir: str = None):
        """
        Initialize the YAML initializer.

        Args:
            init_data_dir: Directory containing YAML initialization files.
                          Defaults to backend/init_data
        """
        if init_data_dir is None:
            # Default to init_data directory in the same location as this file
            current_dir = Path(__file__).parent.parent
            init_data_dir = current_dir / "init_data"

        self.init_data_dir = Path(init_data_dir)
        logger.info(f"YAML initializer configured with directory: {self.init_data_dir}")

    def load_yaml_file(self, file_path: Path) -> Any:
        """
        Load and parse a YAML file.

        Args:
            file_path: Path to the YAML file

        Returns:
            Parsed YAML content (dict or list)
        """
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = yaml.safe_load(f)
                logger.info(f"Loaded YAML file: {file_path}")
                return content
        except Exception as e:
            logger.error(f"Failed to load YAML file {file_path}: {e}")
            raise

    def load_yaml_documents(self, file_path: Path) -> List[Dict[str, Any]]:
        """
        Load multiple YAML documents from a single file (separated by ---).

        Args:
            file_path: Path to the YAML file

        Returns:
            List of parsed YAML documents
        """
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                documents = list(yaml.safe_load_all(f))
                # Filter out None values (empty documents)
                documents = [doc for doc in documents if doc is not None]
                logger.info(f"Loaded {len(documents)} YAML documents from: {file_path}")
                return documents
        except Exception as e:
            logger.error(f"Failed to load YAML documents from {file_path}: {e}")
            raise

    def init_default_user(self, db: Session) -> None:
        """
        Initialize default user from YAML configuration.

        Args:
            db: Database session
        """
        user_file = self.init_data_dir / "default_user.yaml"

        if not user_file.exists():
            logger.warning(f"Default user file not found: {user_file}")
            return

        try:
            user_config = self.load_yaml_file(user_file)

            # Check if user already exists
            existing_user = db.query(User).filter(
                User.user_name == user_config.get('user_name')
            ).first()

            if existing_user:
                logger.info(f"User '{user_config.get('user_name')}' already exists, skipping")
                return

            # Create new user
            new_user = User(
                user_name=user_config.get('user_name'),
                password_hash=user_config.get('password_hash'),
                email=user_config.get('email'),
                git_info=user_config.get('git_info', []),
                is_active=user_config.get('is_active', True)
            )

            db.add(new_user)
            db.commit()
            logger.info(f"Created default user: {user_config.get('user_name')}")

        except Exception as e:
            logger.error(f"Failed to initialize default user: {e}")
            db.rollback()
            raise

    def init_default_resources(self, db: Session) -> None:
        """
        Initialize default resources (Ghost, Model, Shell, Bot, Team) from YAML.

        Args:
            db: Database session
        """
        resources_file = self.init_data_dir / "default_resources.yaml"

        if not resources_file.exists():
            logger.warning(f"Default resources file not found: {resources_file}")
            return

        try:
            documents = self.load_yaml_documents(resources_file)

            for doc in documents:
                if not doc or 'kind' not in doc or 'metadata' not in doc:
                    logger.warning(f"Skipping invalid document: {doc}")
                    continue

                kind = doc.get('kind')
                metadata = doc.get('metadata', {})
                name = metadata.get('name')
                namespace = metadata.get('namespace', 'default')
                user_id = metadata.get('user_id', 1)

                # Check if resource already exists
                existing = db.query(Kind).filter(
                    Kind.user_id == user_id,
                    Kind.kind == kind,
                    Kind.name == name,
                    Kind.namespace == namespace
                ).first()

                if existing:
                    logger.info(f"{kind} '{name}' already exists in namespace '{namespace}', skipping")
                    continue

                # Create new kind resource
                new_kind = Kind(
                    user_id=user_id,
                    kind=kind,
                    name=name,
                    namespace=namespace,
                    json=doc,
                    is_active=True
                )

                db.add(new_kind)
                logger.info(f"Created {kind}: {name} in namespace {namespace}")

            db.commit()
            logger.info("Default resources initialization completed")

        except Exception as e:
            logger.error(f"Failed to initialize default resources: {e}")
            db.rollback()
            raise

    def init_public_shells(self, db: Session) -> None:
        """
        Initialize public shells from YAML configuration.

        Args:
            db: Database session
        """
        shells_file = self.init_data_dir / "public_shells.yaml"

        if not shells_file.exists():
            logger.warning(f"Public shells file not found: {shells_file}")
            return

        try:
            documents = self.load_yaml_documents(shells_file)

            for doc in documents:
                if not doc or 'kind' not in doc or doc.get('kind') != 'Shell':
                    logger.warning(f"Skipping non-Shell document: {doc}")
                    continue

                metadata = doc.get('metadata', {})
                name = metadata.get('name')
                namespace = metadata.get('namespace', 'default')

                # Check if shell already exists
                existing = db.query(PublicShell).filter(
                    PublicShell.name == name,
                    PublicShell.namespace == namespace
                ).first()

                if existing:
                    logger.info(f"Public shell '{name}' already exists in namespace '{namespace}', skipping")
                    continue

                # Create new public shell
                new_shell = PublicShell(
                    name=name,
                    namespace=namespace,
                    json=doc,
                    is_active=True
                )

                db.add(new_shell)
                logger.info(f"Created public shell: {name} in namespace {namespace}")

            db.commit()
            logger.info("Public shells initialization completed")

        except Exception as e:
            logger.error(f"Failed to initialize public shells: {e}")
            db.rollback()
            raise

    def initialize_all(self, db: Session) -> None:
        """
        Run all initialization tasks.

        Args:
            db: Database session
        """
        logger.info("Starting YAML-based initialization...")

        if not self.init_data_dir.exists():
            logger.warning(f"Initialization data directory not found: {self.init_data_dir}")
            logger.info("Skipping YAML initialization")
            return

        try:
            # Initialize in order: user first, then resources
            self.init_default_user(db)
            self.init_default_resources(db)
            self.init_public_shells(db)

            logger.info("YAML-based initialization completed successfully")

        except Exception as e:
            logger.error(f"YAML initialization failed: {e}")
            raise


# Global initializer instance
_initializer = None


def get_initializer() -> YAMLInitializer:
    """Get or create the global YAML initializer instance."""
    global _initializer
    if _initializer is None:
        _initializer = YAMLInitializer()
    return _initializer


def run_yaml_initialization(db: Session) -> None:
    """
    Convenience function to run YAML initialization.

    Args:
        db: Database session
    """
    initializer = get_initializer()
    initializer.initialize_all(db)
