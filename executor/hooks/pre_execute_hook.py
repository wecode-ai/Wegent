import logging
import os
import subprocess
from typing import Optional

logger = logging.getLogger(__name__)


class PreExecuteHook:
    """Pre-execute hook: execute external command before task execution.

    Configuration via environment variables:
        WEGENT_HOOK_PRE_EXECUTE: Path to the hook script
        WEGENT_HOOK_PRE_EXECUTE_TIMEOUT: Timeout in seconds (default: 30)

    The hook script will be called with:
        bash <script_path> <task_dir>

    Environment variables passed to the hook:
        WEGENT_TASK_DIR: Task working directory
        WEGENT_TASK_ID: Task ID
        WEGENT_GIT_URL: Git repository URL
    """

    def __init__(self):
        self.command = os.environ.get("WEGENT_HOOK_PRE_EXECUTE")
        self.timeout = int(os.environ.get("WEGENT_HOOK_PRE_EXECUTE_TIMEOUT", "30"))

    @property
    def enabled(self) -> bool:
        return bool(self.command)

    def execute(
        self,
        task_dir: str,
        task_id: Optional[int] = None,
        git_url: Optional[str] = None,
    ) -> int:
        """Execute pre-execute hook.

        Args:
            task_dir: Task working directory path
            task_id: Task ID
            git_url: Git repository URL

        Returns:
            Exit code, 0 means success
        """
        if not self.enabled:
            return 0

        # Build environment variables
        env = os.environ.copy()
        env["WEGENT_TASK_DIR"] = task_dir
        if task_id is not None:
            env["WEGENT_TASK_ID"] = str(task_id)
        if git_url:
            env["WEGENT_GIT_URL"] = git_url

        # Use bash to execute the script
        cmd = ["bash", self.command, task_dir]

        try:
            logger.info(f"Executing pre-execute hook: {' '.join(cmd)}")
            result = subprocess.run(
                cmd,
                env=env,
                timeout=self.timeout,
                capture_output=True,
                text=True,
            )

            if result.stdout:
                logger.info(f"Hook stdout: {result.stdout}")
            if result.stderr:
                logger.warning(f"Hook stderr: {result.stderr}")

            logger.info(f"Pre-execute hook completed: exit_code={result.returncode}")
            return result.returncode

        except subprocess.TimeoutExpired:
            logger.error(f"Pre-execute hook timed out after {self.timeout}s")
            return -1
        except FileNotFoundError:
            logger.error(f"Hook script not found: {self.command}")
            return -1
        except Exception as e:
            logger.error(f"Pre-execute hook failed: {e}")
            return -1


# Global singleton
_hook_instance: Optional[PreExecuteHook] = None


def get_pre_execute_hook() -> PreExecuteHook:
    """Get the global PreExecuteHook instance."""
    global _hook_instance
    if _hook_instance is None:
        _hook_instance = PreExecuteHook()
    return _hook_instance
