# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Shared fixtures for group knowledge base permission tests.
"""

import pytest
from sqlalchemy.orm import Session

from app.core.security import get_password_hash

# Import all models to ensure they're registered with Base
from app.models import *
from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.models.namespace import Namespace
from app.models.namespace_member import NamespaceMember
from app.models.user import User
from app.schemas.knowledge import (
    KnowledgeBaseCreate,
    KnowledgeBaseUpdate,
    KnowledgeDocumentCreate,
)
from app.schemas.namespace import GroupRole
from app.services.knowledge.knowledge_service import KnowledgeService


@pytest.fixture(scope="function")
def test_group_owner(test_db: Session) -> User:
    """Create a test user who will be group owner."""
    user = User(
        user_name="groupowner",
        password_hash=get_password_hash("owner123"),
        email="owner@example.com",
        is_active=True,
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


@pytest.fixture(scope="function")
def test_group_maintainer(test_db: Session) -> User:
    """Create a test user who will be group maintainer."""
    user = User(
        user_name="groupmaintainer",
        password_hash=get_password_hash("maintainer123"),
        email="maintainer@example.com",
        is_active=True,
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


@pytest.fixture(scope="function")
def test_group_developer(test_db: Session) -> User:
    """Create a test user who will be group developer."""
    user = User(
        user_name="groupdeveloper",
        password_hash=get_password_hash("developer123"),
        email="developer@example.com",
        is_active=True,
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


@pytest.fixture(scope="function")
def test_group_reporter(test_db: Session) -> User:
    """Create a test user who will be group reporter."""
    user = User(
        user_name="groupreporter",
        password_hash=get_password_hash("reporter123"),
        email="reporter@example.com",
        is_active=True,
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


@pytest.fixture(scope="function")
def test_group(test_db: Session, test_group_owner: User) -> Namespace:
    """Create a test group namespace."""
    namespace = Namespace(
        name="testgroup",
        display_name="Test Group",
        description="A test group for knowledge base permission testing",
        owner_user_id=test_group_owner.id,
        is_active=True,
    )
    test_db.add(namespace)
    test_db.commit()
    test_db.refresh(namespace)
    return namespace


@pytest.fixture(scope="function")
def test_subgroup(
    test_db: Session, test_group: Namespace, test_group_owner: User
) -> Namespace:
    """Create a test subgroup to test permission inheritance."""
    namespace = Namespace(
        name=f"{test_group.name}/subgroup",
        display_name="Test Subgroup",
        description="A test subgroup for inheritance testing",
        owner_user_id=test_group_owner.id,
        is_active=True,
    )
    test_db.add(namespace)
    test_db.commit()
    test_db.refresh(namespace)
    return namespace


@pytest.fixture(scope="function")
def group_owner_member(
    test_db: Session, test_group: Namespace, test_group_owner: User
) -> NamespaceMember:
    """Add owner as member of the group."""
    member = NamespaceMember(
        group_name=test_group.name,
        user_id=test_group_owner.id,
        role=GroupRole.Owner.value,
        is_active=True,
    )
    test_db.add(member)
    test_db.commit()
    return member


@pytest.fixture(scope="function")
def group_maintainer_member(
    test_db: Session, test_group: Namespace, test_group_maintainer: User
) -> NamespaceMember:
    """Add maintainer as member of the group."""
    member = NamespaceMember(
        group_name=test_group.name,
        user_id=test_group_maintainer.id,
        role=GroupRole.Maintainer.value,
        is_active=True,
    )
    test_db.add(member)
    test_db.commit()
    return member


@pytest.fixture(scope="function")
def group_developer_member(
    test_db: Session, test_group: Namespace, test_group_developer: User
) -> NamespaceMember:
    """Add developer as member of the group."""
    member = NamespaceMember(
        group_name=test_group.name,
        user_id=test_group_developer.id,
        role=GroupRole.Developer.value,
        is_active=True,
    )
    test_db.add(member)
    test_db.commit()
    return member


@pytest.fixture(scope="function")
def group_reporter_member(
    test_db: Session, test_group: Namespace, test_group_reporter: User
) -> NamespaceMember:
    """Add reporter as member of the group."""
    member = NamespaceMember(
        group_name=test_group.name,
        user_id=test_group_reporter.id,
        role=GroupRole.Reporter.value,
        is_active=True,
    )
    test_db.add(member)
    test_db.commit()
    return member


@pytest.fixture(scope="function")
def group_kb(
    test_db: Session,
    test_group: Namespace,
    test_group_owner: User,
    group_owner_member: NamespaceMember,
) -> Kind:
    """Create a knowledge base in the test group."""
    kb_data = KnowledgeBaseCreate(
        name="Test Group KB",
        description="A test knowledge base in group",
        namespace=test_group.name,
    )
    kb_id = KnowledgeService.create_knowledge_base(
        db=test_db,
        user_id=test_group_owner.id,
        data=kb_data,
    )
    kb = test_db.query(Kind).filter(Kind.id == kb_id).first()
    return kb


@pytest.fixture(scope="function")
def subgroup_kb(
    test_db: Session,
    test_subgroup: Namespace,
    test_group_owner: User,
    group_owner_member: NamespaceMember,
) -> Kind:
    """Create a knowledge base in the test subgroup."""
    kb_data = KnowledgeBaseCreate(
        name="Test Subgroup KB",
        description="A test knowledge base in subgroup",
        namespace=test_subgroup.name,
    )
    kb_id = KnowledgeService.create_knowledge_base(
        db=test_db,
        user_id=test_group_owner.id,
        data=kb_data,
    )
    kb = test_db.query(Kind).filter(Kind.id == kb_id).first()
    return kb


@pytest.fixture(scope="function")
def group_kb_document(
    test_db: Session,
    group_kb: Kind,
    test_group_owner: User,
) -> KnowledgeDocument:
    """Create a document in the group knowledge base."""
    doc_data = KnowledgeDocumentCreate(
        name="Test Document",
        file_extension="txt",
        file_size=100,
        source_type="text",
    )
    doc = KnowledgeService.create_document(
        db=test_db,
        knowledge_base_id=group_kb.id,
        user_id=test_group_owner.id,
        data=doc_data,
    )
    return doc
