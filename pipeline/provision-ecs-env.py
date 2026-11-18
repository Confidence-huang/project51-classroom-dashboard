"""交互输入 EMQX 密码并写入 ECS 的 root-only 环境文件，不在电脑磁盘、命令行或 Git 留明文。

调用示例：python pipeline/provision-ecs-env.py --user classroom_test
"""

import argparse
import getpass
import json
import subprocess
import time


def main():
    parser = argparse.ArgumentParser(description="Provision EMQX credentials to ECS public API env file")
    parser.add_argument("--ssh-host", default="project51-ecs", help="SSH host alias in ~/.ssh/config")
    parser.add_argument("--mqtt-url", default="mqtts://i1103de1.ala.cn-hangzhou.emqxsl.cn:8883")
    parser.add_argument("--topic", default="classroom/room01/telemetry")
    parser.add_argument("--user", required=True, help="EMQX username (prefer read-only subscriber)")
    args = parser.parse_args()

    password = getpass.getpass("EMQX MQTT password (hidden): ")
    if not password:
        raise SystemExit("ERROR: empty password")
    if any(ch in password for ch in ("\r", "\n")):
        raise SystemExit("ERROR: password must not contain newlines")

    env_payload = (
        f"MQTT_URL={args.mqtt_url}\n"
        f"MQTT_TOPIC={args.topic}\n"
        f"MQTT_USER={args.user}\n"
        f"MQTT_PASSWORD={password}\n"
    ).encode("utf-8")
    password = None

    remote_cmd = (
        "sudo install -d -m 700 -o root -g root /etc/project51-classroom && "
        "sudo install -m 600 -o root -g root /dev/stdin /etc/project51-classroom/public-api.env && "
        "sudo systemctl enable --now project51-public-api.service && "
        "sudo systemctl restart project51-public-api.service"
    )
    subprocess.run(
        ["ssh", "-o", "BatchMode=yes", args.ssh_host, remote_cmd],
        input=env_payload,
        check=True,
    )
    print("ECS_ENV_WRITTEN_AND_STARTED")

    # 等待服务连接 EMQX 并检查本机只读 API 状态（不含任何密码）。
    for _ in range(8):
        time.sleep(1.5)
        check = subprocess.run(
            ["ssh", "-o", "BatchMode=yes", args.ssh_host, "curl -sS --max-time 3 http://127.0.0.1:8900/api/telemetry"],
            capture_output=True,
            text=True,
        )
        if check.returncode == 0 and check.stdout.strip():
            data = json.loads(check.stdout)
            if data.get("broker_connected"):
                latest = data.get("latest")
                seq = latest.get("seq") if isinstance(latest, dict) else None
                print(f"ECS_PUBLIC_API_OK broker_connected=True history_count={len(data.get('history', []))} latest_seq={seq}")
                return
    print("ECS_PUBLIC_API_STARTED_WAIT_BROKER (re-check /api/telemetry in a few seconds)")


if __name__ == "__main__":
    main()
