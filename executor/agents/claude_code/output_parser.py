# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Output parser for Claude Code agent to detect CI-related triggers
"""

import re
from dataclasses import dataclass
from enum import Enum
from typing import List, Optional

from shared.logger import setup_logger

logger = setup_logger("output_parser")


class TriggerType(str, Enum):
    """Type of trigger detected in agent output"""
    GIT_PUSH = "git_push"
    PR_CREATED = "pr_created"
    MR_CREATED = "mr_created"


class GitPlatform(str, Enum):
    """Git platform type"""
    GITHUB = "GITHUB"
    GITLAB = "GITLAB"


@dataclass
class CITriggerInfo:
    """Information about a CI trigger detected in output"""
    trigger_type: TriggerType
    git_platform: GitPlatform
    repo_full_name: Optional[str] = None
    branch_name: Optional[str] = None
    pr_number: Optional[str] = None
    pr_url: Optional[str] = None
    git_domain: Optional[str] = None


# Regex patterns for detecting CI triggers
PATTERNS = {
    # Git push detection
    "git_push": [
        # Standard git push output
        r"(?:To|Enumerating|Counting|Compressing|Writing|remote:).*\n.*(?:branch|->)\s+['\"]?(\S+)['\"]?\s*$",
        # Git push command
        r"git\s+push\s+(?:-[a-z]+\s+)*(\S+)\s+(\S+)",
        r"git\s+push\s+origin\s+(\S+)",
        r"git\s+push\s+-u\s+origin\s+(\S+)",
    ],
    # GitHub PR creation
    "gh_pr_create": [
        # gh pr create command
        r"gh\s+pr\s+create",
        # PR URL from gh output
        r"https?://(?:www\.)?github\.com/([^/]+/[^/]+)/pull/(\d+)",
        # Generic GitHub PR URL
        r"https?://([^/]+)/([^/]+/[^/]+)/pull/(\d+)",
    ],
    # GitLab MR creation
    "glab_mr_create": [
        # glab mr create command
        r"glab\s+mr\s+create",
        # MR URL from glab output
        r"https?://(?:www\.)?gitlab\.com/([^/]+/[^/]+)/-/merge_requests/(\d+)",
        # Generic GitLab MR URL
        r"https?://([^/]+)/([^/]+/[^/]+)/-/merge_requests/(\d+)",
    ],
}

# Branch extraction patterns
BRANCH_PATTERNS = [
    # git push output: "To git@github.com:owner/repo.git\n * [new branch]      branch-name -> branch-name"
    r"\*\s+\[new branch\]\s+(\S+)\s+->",
    # git push output: "branch 'branch-name' set up to track"
    r"branch\s+'([^']+)'\s+set up to track",
    # gh pr create output often shows branch
    r"--head\s+['\"]?([^'\"]+)['\"]?",
    # Common branch reference
    r"(?:origin|upstream)/(\S+)",
]

# Repository extraction patterns
REPO_PATTERNS = [
    # GitHub HTTPS URL
    r"github\.com[:/]([^/]+/[^/\.]+)",
    # GitLab HTTPS URL
    r"gitlab\.com[:/]([^/]+/[^/\.]+)",
    # Generic git remote with domain
    r"(?:https?://|git@)([^/]+)[:/]([^/]+/[^/\.]+)",
]


class OutputParser:
    """Parser for detecting CI triggers in agent output"""

    def __init__(self):
        self.compiled_patterns = {}
        for category, patterns in PATTERNS.items():
            self.compiled_patterns[category] = [
                re.compile(p, re.IGNORECASE | re.MULTILINE) for p in patterns
            ]

    def parse(self, output: str) -> List[CITriggerInfo]:
        """
        Parse agent output and detect CI-related triggers

        Args:
            output: The agent's output text

        Returns:
            List of detected CI triggers
        """
        if not output:
            return []

        triggers = []

        # Check for git push
        if self._detect_git_push(output):
            trigger = self._extract_git_push_info(output)
            if trigger:
                triggers.append(trigger)

        # Check for GitHub PR creation
        gh_trigger = self._detect_github_pr(output)
        if gh_trigger:
            triggers.append(gh_trigger)

        # Check for GitLab MR creation
        gl_trigger = self._detect_gitlab_mr(output)
        if gl_trigger:
            triggers.append(gl_trigger)

        logger.info(f"Parsed output, found {len(triggers)} CI triggers")
        return triggers

    def _detect_git_push(self, output: str) -> bool:
        """Detect if output contains git push"""
        # Check for git push command
        if re.search(r"git\s+push", output, re.IGNORECASE):
            return True
        # Check for push output indicators
        if "Everything up-to-date" in output:
            return True
        if "[new branch]" in output or "[new tag]" in output:
            return True
        if re.search(r"\d+\s+files?\s+changed", output):
            # This might be commit output, check for push indicators
            if "To " in output and ("github.com" in output or "gitlab.com" in output):
                return True
        return False

    def _extract_git_push_info(self, output: str) -> Optional[CITriggerInfo]:
        """Extract git push information from output"""
        branch_name = self._extract_branch_name(output)
        repo_info = self._extract_repo_info(output)

        if branch_name or repo_info:
            platform = GitPlatform.GITHUB
            git_domain = None

            if repo_info:
                git_domain = repo_info.get("domain")
                if git_domain and "gitlab" in git_domain.lower():
                    platform = GitPlatform.GITLAB

            return CITriggerInfo(
                trigger_type=TriggerType.GIT_PUSH,
                git_platform=platform,
                repo_full_name=repo_info.get("repo") if repo_info else None,
                branch_name=branch_name,
                git_domain=git_domain,
            )
        return None

    def _detect_github_pr(self, output: str) -> Optional[CITriggerInfo]:
        """Detect GitHub PR creation in output"""
        # Check for gh pr create command
        if not re.search(r"gh\s+pr\s+create", output, re.IGNORECASE):
            # Also check for PR URL in output
            if "github.com" not in output or "/pull/" not in output:
                return None

        # Try to extract PR URL
        pr_match = re.search(
            r"https?://([^/]+)/([^/]+/[^/]+)/pull/(\d+)",
            output,
            re.IGNORECASE,
        )

        pr_url = None
        pr_number = None
        repo_full_name = None
        git_domain = "github.com"

        if pr_match:
            git_domain = pr_match.group(1)
            repo_full_name = pr_match.group(2)
            pr_number = pr_match.group(3)
            pr_url = pr_match.group(0)

        # Extract branch name
        branch_name = self._extract_branch_name(output)

        return CITriggerInfo(
            trigger_type=TriggerType.PR_CREATED,
            git_platform=GitPlatform.GITHUB,
            repo_full_name=repo_full_name,
            branch_name=branch_name,
            pr_number=pr_number,
            pr_url=pr_url,
            git_domain=git_domain,
        )

    def _detect_gitlab_mr(self, output: str) -> Optional[CITriggerInfo]:
        """Detect GitLab MR creation in output"""
        # Check for glab mr create command
        if not re.search(r"glab\s+mr\s+create", output, re.IGNORECASE):
            # Also check for MR URL in output
            if "gitlab" not in output.lower() or "/merge_requests/" not in output:
                return None

        # Try to extract MR URL
        mr_match = re.search(
            r"https?://([^/]+)/([^/]+(?:/[^/]+)*)/-/merge_requests/(\d+)",
            output,
            re.IGNORECASE,
        )

        mr_url = None
        mr_number = None
        repo_full_name = None
        git_domain = "gitlab.com"

        if mr_match:
            git_domain = mr_match.group(1)
            repo_full_name = mr_match.group(2)
            mr_number = mr_match.group(3)
            mr_url = mr_match.group(0)

        # Extract branch name
        branch_name = self._extract_branch_name(output)

        return CITriggerInfo(
            trigger_type=TriggerType.MR_CREATED,
            git_platform=GitPlatform.GITLAB,
            repo_full_name=repo_full_name,
            branch_name=branch_name,
            pr_number=mr_number,
            pr_url=mr_url,
            git_domain=git_domain,
        )

    def _extract_branch_name(self, output: str) -> Optional[str]:
        """Extract branch name from output"""
        for pattern in BRANCH_PATTERNS:
            match = re.search(pattern, output)
            if match:
                return match.group(1)

        # Try to find branch in git push command
        push_match = re.search(
            r"git\s+push\s+(?:-[a-z]+\s+)*\S+\s+(\S+)",
            output,
            re.IGNORECASE,
        )
        if push_match:
            branch = push_match.group(1)
            # Clean up branch name (remove HEAD: prefix if present)
            if ":" in branch:
                branch = branch.split(":")[-1]
            return branch

        return None

    def _extract_repo_info(self, output: str) -> Optional[dict]:
        """Extract repository information from output"""
        # Check for GitHub
        gh_match = re.search(r"github\.com[:/]([^/]+/[^/\.\s]+)", output)
        if gh_match:
            return {"domain": "github.com", "repo": gh_match.group(1)}

        # Check for GitLab
        gl_match = re.search(r"gitlab\.com[:/]([^/]+/[^/\.\s]+)", output)
        if gl_match:
            return {"domain": "gitlab.com", "repo": gl_match.group(1)}

        # Check for generic git remote
        remote_match = re.search(
            r"(?:https?://|git@)([^/:]+)[:/]([^/]+/[^/\.\s]+)",
            output,
        )
        if remote_match:
            return {"domain": remote_match.group(1), "repo": remote_match.group(2)}

        return None


# Global parser instance
output_parser = OutputParser()


def parse_agent_output(output: str) -> List[CITriggerInfo]:
    """
    Parse agent output for CI triggers

    Args:
        output: The agent's output text

    Returns:
        List of detected CI triggers
    """
    return output_parser.parse(output)
