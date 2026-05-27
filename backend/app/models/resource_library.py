# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)

from app.db.base import Base

RESOURCE_TYPE_AGENT = "agent"
RESOURCE_TYPE_SKILL = "skill"
RESOURCE_TYPE_MCP = "mcp"

RESOURCE_LIBRARY_STATUS_PUBLISHED = "published"
RESOURCE_LIBRARY_STATUS_ARCHIVED = "archived"

INSTALL_STATUS_INSTALLED = "installed"
INSTALL_STATUS_REMOVED = "removed"
INSTALL_STATUS_FAILED = "failed"


class ResourceLibraryListing(Base):
    """Catalog entry for a reusable resource."""

    __tablename__ = "resource_library_listings"

    id = Column(Integer, primary_key=True)
    resource_type = Column(String(20), nullable=False)
    name = Column(String(100), nullable=False)
    display_name = Column(String(200), nullable=True)
    description = Column(Text, nullable=True)
    icon = Column(String(100), nullable=True)
    tags = Column(JSON, nullable=False, default=list)
    publisher_user_id = Column(Integer, nullable=False, index=True)
    status = Column(
        String(20),
        nullable=False,
        default=RESOURCE_LIBRARY_STATUS_PUBLISHED,
    )
    current_version_id = Column(Integer, nullable=True)
    install_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=datetime.now)
    updated_at = Column(
        DateTime,
        nullable=False,
        default=datetime.now,
        onupdate=datetime.now,
    )

    __table_args__ = (
        UniqueConstraint(
            "resource_type",
            "name",
            "publisher_user_id",
            name="uq_resource_library_listing_owner_name",
        ),
        Index(
            "ix_resource_library_listings_discovery",
            "status",
            "resource_type",
            "updated_at",
        ),
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class ResourceLibraryVersion(Base):
    """Versioned install package for a resource library listing."""

    __tablename__ = "resource_library_versions"

    id = Column(Integer, primary_key=True)
    listing_id = Column(
        Integer,
        ForeignKey("resource_library_listings.id", ondelete="CASCADE"),
        nullable=False,
    )
    version = Column(String(50), nullable=False)
    manifest = Column(JSON, nullable=False)
    source_kind_id = Column(Integer, nullable=True)
    source_binary_id = Column(Integer, nullable=True)
    is_current = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, nullable=False, default=datetime.now)
    updated_at = Column(
        DateTime,
        nullable=False,
        default=datetime.now,
        onupdate=datetime.now,
    )

    __table_args__ = (
        UniqueConstraint(
            "listing_id",
            "version",
            name="uq_resource_library_version_listing_version",
        ),
        Index(
            "ix_resource_library_versions_current",
            "listing_id",
            "is_current",
        ),
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class ResourceLibraryInstall(Base):
    """User install record for a resource library version."""

    __tablename__ = "resource_library_installs"

    id = Column(Integer, primary_key=True)
    listing_id = Column(
        Integer,
        ForeignKey("resource_library_listings.id", ondelete="CASCADE"),
        nullable=False,
    )
    version_id = Column(
        Integer,
        ForeignKey("resource_library_versions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id = Column(Integer, nullable=False)
    resource_type = Column(String(20), nullable=False)
    installed_kind_id = Column(Integer, nullable=True)
    installed_reference = Column(JSON, nullable=False, default=dict)
    install_status = Column(
        String(20),
        nullable=False,
        default=INSTALL_STATUS_INSTALLED,
    )
    error_message = Column(Text, nullable=True)
    installed_at = Column(DateTime, nullable=False, default=datetime.now)
    updated_at = Column(
        DateTime,
        nullable=False,
        default=datetime.now,
        onupdate=datetime.now,
    )

    __table_args__ = (
        UniqueConstraint(
            "listing_id",
            "user_id",
            name="uq_resource_library_install_listing_user",
        ),
        Index(
            "ix_resource_library_installs_user_type_status",
            "user_id",
            "resource_type",
            "install_status",
        ),
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


__all__ = [
    "INSTALL_STATUS_FAILED",
    "INSTALL_STATUS_INSTALLED",
    "INSTALL_STATUS_REMOVED",
    "RESOURCE_LIBRARY_STATUS_ARCHIVED",
    "RESOURCE_LIBRARY_STATUS_PUBLISHED",
    "RESOURCE_TYPE_AGENT",
    "RESOURCE_TYPE_MCP",
    "RESOURCE_TYPE_SKILL",
    "ResourceLibraryInstall",
    "ResourceLibraryListing",
    "ResourceLibraryVersion",
]
