#!/usr/bin/env python3
"""
Project Health Check Script

A utility to check the health of the Wegent project by verifying:
- Required directories exist
- Configuration files are present
- Dependencies are properly configured
"""

import os
import sys
from pathlib import Path
from typing import List, Tuple


class Colors:
    """Terminal color codes."""

    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    RESET = '\033[0m'


def check_directory(path: Path, description: str) -> Tuple[bool, str]:
    """Check if a directory exists."""
    if path.exists() and path.is_dir():
        return True, f"{description}: OK"
    return False, f"{description}: MISSING"


def check_file(path: Path, description: str) -> Tuple[bool, str]:
    """Check if a file exists."""
    if path.exists() and path.is_file():
        return True, f"{description}: OK"
    return False, f"{description}: MISSING"


def print_result(success: bool, message: str) -> None:
    """Print a check result with color."""
    color = Colors.GREEN if success else Colors.RED
    status = "✓" if success else "✗"
    print(f"{color}{status}{Colors.RESET} {message}")


def main() -> int:
    """Run all health checks."""
    project_root = Path(__file__).parent.parent

    print("=" * 50)
    print("Wegent Project Health Check")
    print("=" * 50)
    print()

    checks: List[Tuple[bool, str]] = []

    # Check required directories
    print("Checking required directories...")
    required_dirs = [
        (project_root / "backend", "Backend directory"),
        (project_root / "frontend", "Frontend directory"),
        (project_root / "executor", "Executor directory"),
        (project_root / "shared", "Shared directory"),
        (project_root / "docs", "Documentation directory"),
    ]

    for path, desc in required_dirs:
        result = check_directory(path, desc)
        checks.append(result)
        print_result(result[0], result[1])

    print()

    # Check configuration files
    print("Checking configuration files...")
    config_files = [
        (project_root / ".env.example", "Environment example file"),
        (project_root / "docker-compose.yml", "Docker Compose config"),
        (project_root / "pyproject.toml", "Python project config"),
        (project_root / "README.md", "README file"),
    ]

    for path, desc in config_files:
        result = check_file(path, desc)
        checks.append(result)
        print_result(result[0], result[1])

    print()

    # Check frontend configuration
    print("Checking frontend configuration...")
    frontend_checks = [
        (project_root / "frontend" / "package.json", "Frontend package.json"),
        (project_root / "frontend" / "next.config.js", "Next.js config"),
    ]

    for path, desc in frontend_checks:
        result = check_file(path, desc)
        checks.append(result)
        print_result(result[0], result[1])

    print()

    # Summary
    print("=" * 50)
    passed = sum(1 for check in checks if check[0])
    total = len(checks)

    if passed == total:
        print(f"{Colors.GREEN}All checks passed! ({passed}/{total}){Colors.RESET}")
        return 0
    else:
        print(f"{Colors.YELLOW}Some checks failed. ({passed}/{total} passed){Colors.RESET}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
