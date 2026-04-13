# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Handles the --upgrade flag workflow for executor self-update.

Encapsulates the upgrade process logic to keep main.py clean and focused.
"""

import argparse
import logging
import os
import sys
from pathlib import Path
from typing import Optional

from executor.services.updater.process_manager import ProcessInfo, ProcessManager
from executor.services.updater.updater_service import (
    UpdateResult,
    UpdaterService,
    setup_upgrade_logging,
)
from executor.version import get_version


class UpgradeHandler:
    """Handles the --upgrade flag workflow."""

    def __init__(self, verbose: bool = False):
        """Initialize the upgrade handler.

        Args:
            verbose: If True, enable detailed logging to file.
        """
        self.verbose = verbose
        self.logger = setup_upgrade_logging(verbose=verbose)
        self._process_manager = ProcessManager()

    def handle(self, args: argparse.Namespace) -> int:
        """Execute the upgrade workflow.

        Args:
            args: Parsed command line arguments.

        Returns:
            Exit code (0 for success, 1 for failure).
        """
        # Load device config to get update configuration
        from executor.config.device_config import (
            get_config_path_from_args,
            load_device_config,
        )

        config_path = get_config_path_from_args()
        device_config = load_device_config(config_path)

        # Check for auto-confirm flag
        auto_confirm = getattr(args, "yes", False) or "-y" in sys.argv

        print(f"wegent-executor v{get_version()}")
        print()

        # Check if executor is currently running (for auto-restart)
        running_info = self._process_manager.was_running()

        try:
            # Create updater service with update config
            service = UpdaterService(
                update_config=device_config.update,
                auto_confirm=auto_confirm,
                verbose=self.verbose,
            )
            result = self._run_update(service)

            return self._handle_result(result, running_info)

        except KeyboardInterrupt:
            print()
            print("Update cancelled by user")
            return 1
        except Exception as e:
            print(f"Unexpected error: {e}")
            return 1

    def _run_update(self, service: UpdaterService) -> UpdateResult:
        """Run the update check and download process.

        Args:
            service: Configured UpdaterService instance.

        Returns:
            UpdateResult with the outcome of the update.
        """
        import asyncio

        return asyncio.run(service.check_and_update())

    def _handle_result(
        self, result: UpdateResult, running_info: Optional[ProcessInfo]
    ) -> int:
        """Handle the update result and perform restart if needed.

        Args:
            result: The result of the update operation.
            running_info: ProcessInfo if executor was running before update.

        Returns:
            Exit code (0 for success, 1 for failure).
        """
        if result.success:
            if result.already_latest:
                print("Already running the latest version")
                return 0
            else:
                print()
                print("Update complete!")
                print()
                return self._handle_restart(running_info)
        else:
            print(f"Update failed: {result.error}")
            return 1

    def _handle_restart(self, running_info: Optional[ProcessInfo]) -> int:
        """Handle auto-restart after successful update.

        Args:
            running_info: ProcessInfo if executor was running before update.

        Returns:
            Exit code (0 for success, 1 for failure).
        """
        if running_info:
            print("Restarting executor...")

            # First, terminate the old executor process
            if running_info.pid != os.getpid():
                print(f"Stopping old executor (pid={running_info.pid})...")
                self._process_manager.terminate_process(running_info.pid)

            # Then start new executor (with verbose logging if requested)
            if self._process_manager.restart_executor(verbose=self.verbose):
                print("Executor restarted successfully")
                return 0
            else:
                print("Failed to auto-restart executor")
                print()
                print("Please restart manually:")
                print("  wegent-executor")
                print()
                return 1
        else:
            print("Please restart the executor:")
            print("  wegent-executor")
            print()
            return 0
