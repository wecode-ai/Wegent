import os


K8S_NAMESPACE = os.getenv("K8S_NAMESPACE", "wb-plat-ide")
EXECUTOR_DEFAULT_MAGE = os.getenv(
    "EXECUTOR_IMAGE",
    "",
)
