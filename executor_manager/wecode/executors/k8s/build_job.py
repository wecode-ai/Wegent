def build_job_configuration(executor_name,namespace,task_str,image):
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
                "aigc.weibo.com/executor":"background-agent",
            },
        },
        "spec": {
            "backoffLimit": 3,
            "template": {
                "metadata": {
                    "annotations": {
                        "aigc.weibo.com/email": "weibo_ai_coding@staff.sina.com",
                        "kubus.weibo.com/pod-resource": '{"cpu":"4","memory":"6Gi"}',
                    },
                    "labels": {
                        "app": executor_name,
                        "aigc.weibo.com/devContainerType": "darkFactory",
                        "aigc.weibo.com/executor":"background-agent",
                        "aigc.weibo.com/user": "wecoder",
                        "krs.weibo.com/managed-by": "krs",
                        "kubus.weibo.com/qos-class": "dlc",
                        "krs.weibo.com/type": "online",
                        "admission-webhook.kubus.weibo.com/pod-global-injector-v2": "enabled",
                    },
                },
                "spec": {
                    "containers": [
                        {
                            "args": [
                                "--",
                                "/bin/bash",
                                "-c",
                                "/usr/lib/code-server/bin/start.sh wecoder-darkfactory ephemeral /cloudide/workspace 443 true",
                            ],
                            "command": ["/usr/lib/code-server/bin/tini"],
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
                                {"name":"TASK_INFO","value":task_str},
                                {"name": "EXECUTOR_NAME", "value": executor_name},
                                {"name": "EXECUTOR_NAMESPACE", "value": namespace},
                                {"name": "TZ", "value": "Asia/Shanghai"},
                                {"name": "LANG", "value": "en_US.UTF-8"},
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
                            "lifecycle": {
                                "postStart": {
                                    "exec": {
                                        "command": [
                                            "/bin/bash",
                                            "-c",
                                            "mkdir -pv /cloudide/workspace && /usr/lib/code-server/bin/init.sh wecoder-darkfactory ephemeral /cloudide/workspace 443 true",
                                        ]
                                    }
                                }
                            },
                            "name": executor_name,
                            "ports": [
                                {
                                    "containerPort": 443,
                                    "name": "https",
                                    "protocol": "TCP",
                                }
                            ],
                            "resources": {
                                "requests": {"cpu": "320m", "memory": "1900Mi"}
                            },
                            "terminationMessagePath": "/dev/termination-log",
                            "terminationMessagePolicy": "File",
                            "volumeMounts": [
                                {
                                    "mountPath": "/cloudide/workspace/.wecode/rules-CodeReview/1_workflow.xml",
                                    "name": "wecode-agent-web-env",
                                    "subPath": "rules-codereview-workflow",
                                },
                                {
                                    "mountPath": "/cloudide/workspace/.wecode/rules-CodeReview/2_best_practices.xml",
                                    "name": "wecode-agent-web-env",
                                    "subPath": "rules-codereview-best-practices",
                                },
                                {
                                    "mountPath": "/cloudide/workspace/.wecode/rules-CodeReview/3_common_mistakes_to_avoid.xml",
                                    "name": "wecode-agent-web-env",
                                    "subPath": "rules-codereview-mistakes",
                                },
                                {
                                    "mountPath": "/wecode-agent/config/wecoder/config.yml",
                                    "name": "wecode-agent-web-env",
                                },
                                {"mountPath": "/wecode-agent/logs", "name": "app-logs"},
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
                        {"emptyDir": {}, "name": "app-logs"},
                        {
                            "name": "wecode-ide",
                            "secret": {"defaultMode": 256, "secretName": "wecode-ide"},
                        },
                        {
                            "name": "git-ssh",
                            "secret": {
                                "defaultMode": 256,
                                "secretName": "wecode-secret-wecoder",
                            },
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
                        },
                        {
                            "configMap": {
                                "defaultMode": 420,
                                "name": "wecode-agent-web-env",
                            },
                            "name": "wecode-agent-web-env",
                        },
                    ],
                    "restartPolicy": "OnFailure",
                },
            },
        },
    }
