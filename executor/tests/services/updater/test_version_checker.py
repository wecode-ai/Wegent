# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for version_checker module."""

import platform

import pytest

from executor.services.updater.version_checker import (
    UpdateInfo,
    VersionChecker,
)


class TestUpdateInfo:
    """Test cases for UpdateInfo dataclass."""

    def test_update_info_creation(self):
        """Test creating UpdateInfo."""
        info = UpdateInfo(version="1.6.6", url="https://example.com/download")
        assert info.version == "1.6.6"
        assert info.url == "https://example.com/download"


class TestVersionCheckerCompareVersions:
    """Test cases for VersionChecker.compare_versions static method."""

    def test_compare_versions_equal(self):
        """Test version comparison when versions are equal."""
        assert VersionChecker.compare_versions("1.0.0", "1.0.0") == 0
        assert VersionChecker.compare_versions("2.5.3", "2.5.3") == 0

    def test_compare_versions_current_less_than_latest(self):
        """Test version comparison when current < latest."""
        assert VersionChecker.compare_versions("1.0.0", "1.0.1") == -1
        assert VersionChecker.compare_versions("1.0.0", "1.6.6") == -1
        assert VersionChecker.compare_versions("1.5.0", "2.0.0") == -1

    def test_compare_versions_current_greater_than_latest(self):
        """Test version comparison when current > latest."""
        assert VersionChecker.compare_versions("1.0.1", "1.0.0") == 1
        assert VersionChecker.compare_versions("1.6.6", "1.0.0") == 1
        assert VersionChecker.compare_versions("2.0.0", "1.5.0") == 1

    def test_compare_versions_different_lengths(self):
        """Test version comparison with different version lengths."""
        assert VersionChecker.compare_versions("1.0", "1.0.0") == 0
        assert VersionChecker.compare_versions("1.0.0", "1.0.0.1") == -1
        assert VersionChecker.compare_versions("1.0.0.1", "1.0.0") == 1


class TestVersionCheckerAbstractMethods:
    """Test cases for VersionChecker abstract base class behavior."""

    def test_cannot_instantiate_abstract_class(self):
        """Test that VersionChecker cannot be instantiated directly."""
        with pytest.raises(TypeError):
            VersionChecker()

    def test_concrete_implementation_required(self):
        """Test that concrete implementations must implement abstract methods."""

        class IncompleteChecker(VersionChecker):
            pass

        with pytest.raises(TypeError):
            IncompleteChecker()


class TestPlatformSpecificBinaryNames:
    """Test cases for platform-specific binary name generation."""

    def test_get_binary_name_darwin_arm64(self):
        """Test binary name generation for macOS ARM64."""
        # Import here to use the correct static method
        from executor.services.updater.github_version_checker import (
            GithubVersionChecker,
        )
        from executor.services.updater.registry_version_checker import (
            RegistryVersionChecker,
        )

        with mock.patch("platform.system", return_value="Darwin"):
            with mock.patch("platform.machine", return_value="arm64"):
                assert GithubVersionChecker.get_binary_name() == "wegent-executor-macos-arm64"
                assert (
                    RegistryVersionChecker.get_binary_name() == "wegent-executor-macos-arm64"
                )

    def test_get_binary_name_darwin_x86_64(self):
        """Test binary name generation for macOS x86_64."""
        from executor.services.updater.github_version_checker import (
            GithubVersionChecker,
        )
        from executor.services.updater.registry_version_checker import (
            RegistryVersionChecker,
        )

        with mock.patch("platform.system", return_value="Darwin"):
            with mock.patch("platform.machine", return_value="x86_64"):
                assert GithubVersionChecker.get_binary_name() == "wegent-executor-macos-amd64"
                assert (
                    RegistryVersionChecker.get_binary_name() == "wegent-executor-macos-amd64"
                )

    def test_get_binary_name_linux_arm64(self):
        """Test binary name generation for Linux ARM64."""
        from executor.services.updater.github_version_checker import (
            GithubVersionChecker,
        )
        from executor.services.updater.registry_version_checker import (
            RegistryVersionChecker,
        )

        with mock.patch("platform.system", return_value="Linux"):
            with mock.patch("platform.machine", return_value="arm64"):
                assert GithubVersionChecker.get_binary_name() == "wegent-executor-linux-arm64"
                assert (
                    RegistryVersionChecker.get_binary_name() == "wegent-executor-linux-arm64"
                )

    def test_get_binary_name_linux_amd64(self):
        """Test binary name generation for Linux x86_64."""
        from executor.services.updater.github_version_checker import (
            GithubVersionChecker,
        )
        from executor.services.updater.registry_version_checker import (
            RegistryVersionChecker,
        )

        with mock.patch("platform.system", return_value="Linux"):
            with mock.patch("platform.machine", return_value="x86_64"):
                assert GithubVersionChecker.get_binary_name() == "wegent-executor-linux-amd64"
                assert (
                    RegistryVersionChecker.get_binary_name() == "wegent-executor-linux-amd64"
                )

    def test_get_binary_name_windows(self):
        """Test binary name generation for Windows."""
        from executor.services.updater.github_version_checker import (
            GithubVersionChecker,
        )
        from executor.services.updater.registry_version_checker import (
            RegistryVersionChecker,
        )

        with mock.patch("platform.system", return_value="Windows"):
            with mock.patch("platform.machine", return_value="AMD64"):
                assert (
                    GithubVersionChecker.get_binary_name() == "wegent-executor-windows-amd64"
                )
                assert (
                    RegistryVersionChecker.get_binary_name()
                    == "wegent-executor-windows-amd64"
                )


# Import for patch references
import pytest
from unittest import mock
