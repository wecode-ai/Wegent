def build_job_configuration(
    username, executor_name, namespace, task_str, image, task_id
):
    """
    Build Kubernetes job configuration

    Args:
        job_name: Name for the Kubernetes job
        task_id: ID of the task
        params: Job parameters from prepare_job_parameters

    Returns:
        dict: Kubernetes job configuration
    """
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": executor_name,
            "namespace": namespace,
            "labels": {
                "app": executor_name,
                "krs.weibo.com/type": "online",
                "kubus.weibo.com/qos-class": "dlc",
                "aigc.weibo.com/executor": "wegent",
                "aigc.weibo.com/executor-task-id": str(task_id),
            },
        },
        "spec": {
            "backoffLimit": 3,
            "template": {
                "metadata": {
                    "annotations": {
                        "aigc.weibo.com/email": "weibo_ai_coding@staff.sina.com",
                        "kubus.weibo.com/pod-resource": '{"cpu":"2","memory":"4Gi"}',
                    },
                    "labels": {
                        "app": executor_name,
                        "aigc.weibo.com/devContainerType": "darkFactory",
                        "aigc.weibo.com/executor": "wegent",
                        "aigc.weibo.com/executor-task-id": str(task_id),
                        "aigc.weibo.com/user": username,
                        "aigc.weibo.com/proxy-user": username,
                        "krs.weibo.com/managed-by": "krs",
                        "kubus.weibo.com/qos-class": "dlc",
                        "krs.weibo.com/type": "online",
                        "admission-webhook.kubus.weibo.com/pod-global-injector-v2": "enabled",
                    },
                },
                "spec": {
                    "containers": [
                        {
                            "env": [
                                {
                                    "name": "REGION",
                                    "valueFrom": {
                                        "fieldRef": {
                                            "apiVersion": "v1",
                                            "fieldPath": "metadata.labels['topology.weibo.com/region']",
                                        }
                                    },
                                },
                                {"name": "TASK_INFO", "value": task_str},
                                {"name": "EXECUTOR_NAME", "value": executor_name},
                                {"name": "EXECUTOR_NAMESPACE", "value": namespace},
                                {"name": "TZ", "value": "Asia/Shanghai"},
                                {"name": "LANG", "value": "en_US.UTF-8"},
                                {"name": "PORT", "value": "8080"},
                                {
                                    "name": "CALLBACK_URL",
                                    "value": "http://wegent-executor-manager-web.wb-plat-ide:8080/executor-manager/callback",
                                },
                                {
                                    "name": "ENABLE_CODE_REVIEW_PROCESSING",
                                    "value": "enable",
                                },
                                {
                                    "name": "POD_NAME",
                                    "valueFrom": {
                                        "fieldRef": {
                                            "apiVersion": "v1",
                                            "fieldPath": "metadata.name",
                                        }
                                    },
                                },
                                {
                                    "name": "IP",
                                    "valueFrom": {
                                        "fieldRef": {
                                            "apiVersion": "v1",
                                            "fieldPath": "status.podIP",
                                        }
                                    },
                                },
                            ],
                            "image": image,
                            "imagePullPolicy": "Always",
                            "name": executor_name,
                            "ports": [
                                {
                                    "containerPort": 8080,
                                    "name": "https",
                                    "protocol": "TCP",
                                }
                            ],
                            "terminationMessagePath": "/dev/termination-log",
                            "terminationMessagePolicy": "File",
                            "volumeMounts": [
                                {
                                    "mountPath": "/root/.config/dev-container-type",
                                    "name": "dev-container-type",
                                    "readOnly": True,
                                },
                                {
                                    "mountPath": "/root/.config/user",
                                    "name": "user",
                                    "readOnly": True,
                                },
                                {
                                    "mountPath": "/root/.config/email",
                                    "name": "email",
                                    "readOnly": True,
                                },
                                {
                                    "mountPath": "/root/.local/share/code-server/cert",
                                    "name": "wecode-ide",
                                    "readOnly": True,
                                },
                            ],
                        }
                    ],
                    "dnsConfig": {"options": [{"name": "ndots", "value": "2"}]},
                    "dnsPolicy": "ClusterFirst",
                    "priorityClassName": "krs-high-priority",
                    "schedulerName": "krs-scheduler",
                    "securityContext": {},
                    "terminationGracePeriodSeconds": 60,
                    "tolerations": [
                        {
                            "effect": "NoSchedule",
                            "key": "virtual-kubelet.io/provider",
                            "value": "weibo",
                        }
                    ],
                    "volumes": [
                        {
                            "name": "wecode-ide",
                            "secret": {"defaultMode": 256, "secretName": "wecode-ide"},
                        },
                        {
                            "downwardAPI": {
                                "defaultMode": 420,
                                "items": [
                                    {
                                        "fieldRef": {
                                            "apiVersion": "v1",
                                            "fieldPath": "metadata.labels['aigc.weibo.com/devContainerType']",
                                        },
                                        "path": "data",
                                    }
                                ],
                            },
                            "name": "dev-container-type",
                        },
                        {
                            "downwardAPI": {
                                "defaultMode": 420,
                                "items": [
                                    {
                                        "fieldRef": {
                                            "apiVersion": "v1",
                                            "fieldPath": "metadata.labels['aigc.weibo.com/proxy-user']",
                                        },
                                        "path": "data",
                                    }
                                ],
                            },
                            "name": "user",
                        },
                        {
                            "downwardAPI": {
                                "defaultMode": 420,
                                "items": [
                                    {
                                        "fieldRef": {
                                            "apiVersion": "v1",
                                            "fieldPath": "metadata.annotations['aigc.weibo.com/email']",
                                        },
                                        "path": "data",
                                    }
                                ],
                            },
                            "name": "email",
                        }
                    ],
                    "restartPolicy": "OnFailure",
                },
            },
        },
    }
