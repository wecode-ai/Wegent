import os


K8S_NAMESPACE = os.getenv("K8S_NAMESPACE", "wb-plat-ide")
EXECUTOR_DEFAULT_MAGE = os.getenv(
    "EXECUTOR_IMAGE",
    "",
)

MAX_USER_TASKS = int(os.getenv("MAX_USER_TASKS", 10))
