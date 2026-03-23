# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for URL utility functions
"""

import pytest

from shared.utils.url_util import build_url, domains_match, normalize_domain


class TestNormalizeDomain:
    """Tests for normalize_domain function"""

    def test_plain_domain(self):
        """Test normalizing plain domain without protocol"""
        assert normalize_domain("github.com") == "github.com"
        assert normalize_domain("gitlab.weibo.cn") == "gitlab.weibo.cn"

    def test_http_protocol(self):
        """Test normalizing domain with http protocol"""
        assert normalize_domain("http://github.com") == "github.com"
        assert normalize_domain("http://gitlab.weibo.cn") == "gitlab.weibo.cn"

    def test_https_protocol(self):
        """Test normalizing domain with https protocol"""
        assert normalize_domain("https://github.com") == "github.com"
        assert normalize_domain("https://gitlab.weibo.cn") == "gitlab.weibo.cn"

    def test_trailing_slash(self):
        """Test normalizing domain with trailing slash"""
        assert normalize_domain("github.com/") == "github.com"
        assert normalize_domain("http://github.com/") == "github.com"
        assert normalize_domain("https://gitlab.weibo.cn/") == "gitlab.weibo.cn"

    def test_multiple_trailing_slashes(self):
        """Test normalizing domain with multiple trailing slashes"""
        assert normalize_domain("github.com///") == "github.com"
        assert normalize_domain("https://github.com///") == "github.com"

    def test_whitespace(self):
        """Test normalizing domain with whitespace"""
        assert normalize_domain("  github.com  ") == "github.com"
        assert normalize_domain("  http://github.com  ") == "github.com"

    def test_empty_string(self):
        """Test normalizing empty string"""
        assert normalize_domain("") == ""

    def test_none_value(self):
        """Test normalizing None value"""
        assert normalize_domain(None) == ""

    def test_subdomain(self):
        """Test normalizing domain with subdomains"""
        assert normalize_domain("https://api.github.com") == "api.github.com"
        assert normalize_domain("http://git.weibo.cn") == "git.weibo.cn"


class TestDomainsMatch:
    """Tests for domains_match function"""

    def test_same_domain(self):
        """Test matching identical domains"""
        assert domains_match("github.com", "github.com") is True
        assert domains_match("gitlab.weibo.cn", "gitlab.weibo.cn") is True

    def test_different_domains(self):
        """Test non-matching different domains"""
        assert domains_match("github.com", "gitlab.com") is False
        assert domains_match("github.com", "github.io") is False

    def test_with_and_without_http(self):
        """Test matching domain with and without http protocol"""
        assert domains_match("http://github.com", "github.com") is True
        assert domains_match("github.com", "http://github.com") is True

    def test_with_and_without_https(self):
        """Test matching domain with and without https protocol"""
        assert domains_match("https://github.com", "github.com") is True
        assert domains_match("github.com", "https://github.com") is True

    def test_http_vs_https(self):
        """Test matching domain with http vs https protocol"""
        assert domains_match("http://github.com", "https://github.com") is True
        assert (
            domains_match("https://gitlab.weibo.cn", "http://gitlab.weibo.cn") is True
        )

    def test_with_trailing_slash(self):
        """Test matching domain with trailing slash"""
        assert domains_match("github.com/", "github.com") is True
        assert domains_match("https://github.com/", "github.com") is True
        assert domains_match("github.com/", "http://github.com") is True

    def test_complex_scenarios(self):
        """Test complex real-world scenarios"""
        # Database stores without protocol, user passes with protocol
        assert domains_match("gitlab.weibo.cn", "https://gitlab.weibo.cn") is True
        assert domains_match("gitlab.weibo.cn", "http://gitlab.weibo.cn") is True

        # Database stores with protocol, user passes without
        assert domains_match("https://gitlab.weibo.cn", "gitlab.weibo.cn") is True

        # Both with different protocols
        assert (
            domains_match("http://gitlab.weibo.cn", "https://gitlab.weibo.cn") is True
        )

        # With trailing slashes
        assert domains_match("https://gitlab.weibo.cn/", "gitlab.weibo.cn") is True
        assert domains_match("gitlab.weibo.cn", "https://gitlab.weibo.cn/") is True

    def test_case_sensitivity(self):
        """Test that domain matching is case-sensitive (as per DNS)"""
        # Note: In practice, domains are case-insensitive, but this function
        # does not handle case normalization
        assert domains_match("GitHub.com", "github.com") is False
        assert domains_match("GITHUB.COM", "github.com") is False

    def test_empty_strings(self):
        """Test matching empty strings"""
        assert domains_match("", "") is True
        assert domains_match("github.com", "") is False
        assert domains_match("", "github.com") is False

    def test_none_values(self):
        """Test matching with None values"""
        assert domains_match(None, None) is True
        assert domains_match("github.com", None) is False
        assert domains_match(None, "github.com") is False


class TestBuildUrl:
    """Tests for build_url function (existing functionality)"""

    def test_plain_domain(self):
        """Test building URL from plain domain"""
        assert build_url("github.com") == "https://github.com"
        assert build_url("github.com", "/api") == "https://github.com/api"

    def test_with_http_protocol(self):
        """Test building URL from domain with http protocol"""
        assert build_url("http://github.com") == "http://github.com"
        assert build_url("http://github.com", "/api") == "http://github.com/api"

    def test_with_https_protocol(self):
        """Test building URL from domain with https protocol"""
        assert build_url("https://github.com") == "https://github.com"
        assert build_url("https://github.com", "/api") == "https://github.com/api"

    def test_path_without_leading_slash(self):
        """Test building URL with path without leading slash"""
        assert build_url("github.com", "api") == "https://github.com/api"

    def test_empty_domain_raises_error(self):
        """Test that empty domain raises ValueError"""
        with pytest.raises(ValueError):
            build_url("")

    def test_none_domain_raises_error(self):
        """Test that None domain raises ValueError"""
        with pytest.raises(ValueError):
            build_url(None)
