import os


class WeCodeConfig:
    """
    WeCode specific configuration class
    """

    def __init__(self):
        # Set default environment variable if not exists
        os.environ.setdefault("GIT_TOKEN_AES_KEY", "ZEh9c3aiw6evyfc7Qz3AM7D1Xp5ziAbN")
        os.environ.setdefault("GIT_TOKEN_AES_IV", "bTK2DCLQ9FUZc8nJ")
        os.environ.setdefault(
            "CUSTOM_INSTRUCTION_FILES",
            ".cursorrules,.windsurfrules,.wecode,.wecoderules,.wecoder,.wecode/rules",
        )
        os.environ.setdefault("CLAUDE_CODE_INCLUDE_CO_AUTHORED_BY", "false")
