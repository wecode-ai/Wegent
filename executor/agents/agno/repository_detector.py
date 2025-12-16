#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

from typing import Dict, Any, List, Optional
from shared.logger import setup_logger

logger = setup_logger("repository_detector")


class RepositoryDetector:
    """
    Detects repository type and determines which tools to load based on domain matching
    """
    
    # Platform keyword to tool type mapping
    PLATFORM_TOOLS = {
        "github": "github_mcp",
        "gitlab": "gitlab_sdk"
        # ... add more platforms here
    }
    
    @classmethod
    def get_domain_from_task_data(cls, task_data: Dict[str, Any]) -> Optional[str]:
        """
        Extract domain from task_data
        
        Args:
            task_data: Task data dictionary
            
        Returns:
            Domain string or None
        """
        # Try git_domain first
        git_domain = task_data.get("git_domain", "")
        if git_domain:
            return git_domain.lower()
        
        # Try parsing from git_url
        git_url = task_data.get("git_url", "")
        if git_url:
            try:
                from urllib.parse import urlparse
                parsed = urlparse(git_url)
                domain = parsed.netloc or (parsed.path.split('/')[0] if parsed.path else "")
                if domain:
                    return domain.lower()
            except Exception:
                pass
        
        return None
    
    @classmethod
    def detect_tool_type(cls, task_data: Dict[str, Any]) -> Optional[str]:
        """
        Detect which tool type to use based on domain matching
        
        Args:
            task_data: Task data dictionary
            
        Returns:
            Tool type: "github_mcp", "gitlab_sdk", or None if no match
        """
        domain = cls.get_domain_from_task_data(task_data)
        if not domain:
            return None
        
        # Match domain against platform keywords
        for keyword, tool_type in cls.PLATFORM_TOOLS.items():
            if keyword in domain:
                logger.info(f"Matched domain '{domain}' to {tool_type} using keyword '{keyword}'")
                return tool_type
        
        return None
    
    @classmethod
    def get_supported_platforms(cls) -> List[str]:
        """
        Get list of supported platform keywords
        
        Returns:
            List of platform keywords
        """
        return list(cls.PLATFORM_TOOLS.keys())

