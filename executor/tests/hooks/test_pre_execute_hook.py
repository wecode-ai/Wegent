import os
import tempfile
from unittest import mock

import pytest

from executor.hooks.pre_execute_hook import PreExecuteHook, get_pre_execute_hook


class TestPreExecuteHook:
    """Tests for PreExecuteHook class."""

    def test_enabled_returns_false_when_no_env_var(self):
        """Test that hook is disabled when WEGENT_HOOK_PRE_EXECUTE is not set."""
        with mock.patch.dict(os.environ, {}, clear=True):
            hook = PreExecuteHook()
            assert hook.enabled is False

    def test_enabled_returns_true_when_env_var_set(self):
        """Test that hook is enabled when WEGENT_HOOK_PRE_EXECUTE is set."""
        with mock.patch.dict(
            os.environ, {"WEGENT_HOOK_PRE_EXECUTE": "/path/to/script.sh"}, clear=True
        ):
            hook = PreExecuteHook()
            assert hook.enabled is True

    def test_default_timeout_is_30(self):
        """Test that default timeout is 30 seconds."""
        with mock.patch.dict(os.environ, {}, clear=True):
            hook = PreExecuteHook()
            assert hook.timeout == 30

    def test_custom_timeout_from_env(self):
        """Test that custom timeout can be set via environment variable."""
        with mock.patch.dict(
            os.environ,
            {
                "WEGENT_HOOK_PRE_EXECUTE": "/path/to/script.sh",
                "WEGENT_HOOK_PRE_EXECUTE_TIMEOUT": "60",
            },
            clear=True,
        ):
            hook = PreExecuteHook()
            assert hook.timeout == 60

    def test_execute_returns_0_when_disabled(self):
        """Test that execute returns 0 when hook is disabled."""
        with mock.patch.dict(os.environ, {}, clear=True):
            hook = PreExecuteHook()
            result = hook.execute("/tmp/task_dir")
            assert result == 0

    def test_execute_runs_script_with_bash(self):
        """Test that hook script is executed with bash."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".sh", delete=False) as f:
            f.write('echo "task_dir=$1"\n')
            f.write('echo "WEGENT_TASK_DIR=$WEGENT_TASK_DIR"\n')
            f.write('echo "WEGENT_TASK_ID=$WEGENT_TASK_ID"\n')
            f.write('echo "WEGENT_GIT_URL=$WEGENT_GIT_URL"\n')
            f.write("exit 0\n")
            script_path = f.name

        try:
            with mock.patch.dict(
                os.environ,
                {"WEGENT_HOOK_PRE_EXECUTE": script_path},
                clear=True,
            ):
                hook = PreExecuteHook()
                result = hook.execute(
                    task_dir="/tmp/test_task",
                    task_id=123,
                    git_url="https://github.com/test/repo.git",
                )
                assert result == 0
        finally:
            os.unlink(script_path)

    def test_execute_returns_script_exit_code(self):
        """Test that execute returns the script's exit code."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".sh", delete=False) as f:
            f.write("exit 42\n")
            script_path = f.name

        try:
            with mock.patch.dict(
                os.environ,
                {"WEGENT_HOOK_PRE_EXECUTE": script_path},
                clear=True,
            ):
                hook = PreExecuteHook()
                result = hook.execute("/tmp/task_dir")
                assert result == 42
        finally:
            os.unlink(script_path)

    def test_execute_returns_minus_1_on_timeout(self):
        """Test that execute returns -1 when script times out."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".sh", delete=False) as f:
            f.write("sleep 10\n")
            script_path = f.name

        try:
            with mock.patch.dict(
                os.environ,
                {
                    "WEGENT_HOOK_PRE_EXECUTE": script_path,
                    "WEGENT_HOOK_PRE_EXECUTE_TIMEOUT": "1",
                },
                clear=True,
            ):
                hook = PreExecuteHook()
                result = hook.execute("/tmp/task_dir")
                assert result == -1
        finally:
            os.unlink(script_path)

    def test_execute_returns_nonzero_when_script_not_found(self):
        """Test that execute returns non-zero when script file doesn't exist."""
        with mock.patch.dict(
            os.environ,
            {"WEGENT_HOOK_PRE_EXECUTE": "/nonexistent/script.sh"},
            clear=True,
        ):
            hook = PreExecuteHook()
            result = hook.execute("/tmp/task_dir")
            # bash returns 127 when command not found
            assert result == 127

    def test_execute_passes_env_variables(self):
        """Test that environment variables are correctly passed to the script."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".sh", delete=False) as f:
            # Script that verifies environment variables
            f.write('if [ "$WEGENT_TASK_DIR" != "/tmp/test_task" ]; then exit 1; fi\n')
            f.write('if [ "$WEGENT_TASK_ID" != "456" ]; then exit 2; fi\n')
            f.write(
                'if [ "$WEGENT_GIT_URL" != "https://github.com/test/repo" ]; then exit 3; fi\n'
            )
            f.write("exit 0\n")
            script_path = f.name

        try:
            with mock.patch.dict(
                os.environ,
                {"WEGENT_HOOK_PRE_EXECUTE": script_path},
                clear=True,
            ):
                hook = PreExecuteHook()
                result = hook.execute(
                    task_dir="/tmp/test_task",
                    task_id=456,
                    git_url="https://github.com/test/repo",
                )
                assert result == 0
        finally:
            os.unlink(script_path)

    def test_execute_passes_task_dir_as_argument(self):
        """Test that task_dir is passed as first argument to script."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".sh", delete=False) as f:
            f.write('if [ "$1" != "/tmp/my_task_dir" ]; then exit 1; fi\n')
            f.write("exit 0\n")
            script_path = f.name

        try:
            with mock.patch.dict(
                os.environ,
                {"WEGENT_HOOK_PRE_EXECUTE": script_path},
                clear=True,
            ):
                hook = PreExecuteHook()
                result = hook.execute(task_dir="/tmp/my_task_dir")
                assert result == 0
        finally:
            os.unlink(script_path)


class TestGetPreExecuteHook:
    """Tests for get_pre_execute_hook function."""

    def test_returns_singleton_instance(self):
        """Test that get_pre_execute_hook returns the same instance."""
        # Reset the global instance
        import executor.hooks.pre_execute_hook as hook_module

        hook_module._hook_instance = None

        hook1 = get_pre_execute_hook()
        hook2 = get_pre_execute_hook()
        assert hook1 is hook2

        # Clean up
        hook_module._hook_instance = None
