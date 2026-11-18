"""交互式配置 ECS 网页 LLM Agent 的模型平台与 API Key，写入 root-only 环境文件。

不在本机磁盘、命令行历史或 Git 中保留明文 API Key；不影响现有 EMQX 凭据文件。
调用示例：python pipeline/provision-llm-env.py
"""

import argparse
import getpass
import json
import subprocess
import time
from urllib.parse import urlparse

PRESETS = [
    ("1", "deepseek", "DeepSeek（默认推荐）", "https://api.deepseek.com/v1", "deepseek-chat"),
    ("2", "dashscope", "阿里云百炼 · 通义千问", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"),
    ("3", "zhipu", "智谱清言 · GLM", "https://open.bigmodel.cn/api/paas/v4", "glm-4.5-air"),
    ("4", "siliconflow", "硅基流动 · SiliconFlow", "https://api.siliconflow.cn/v1", "Qwen/Qwen2.5-7B-Instruct"),
    ("5", "custom", "自定义 OpenAI 兼容接口", "", ""),
]


def prompt_default(label: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    value = input(f"{label}{suffix}: ").strip()
    return value or default


def validate_no_newlines(name: str, value: str) -> str:
    if not value:
        raise SystemExit(f"ERROR: {name} 不能为空")
    if any(ch in value for ch in ("\r", "\n")):
        raise SystemExit(f"ERROR: {name} 不能包含换行符")
    return value


def validate_https_url(raw_url: str) -> str:
    cleaned = validate_no_newlines("LLM_BASE_URL", raw_url).rstrip("/")
    parsed = urlparse(cleaned)
    if parsed.scheme != "https" or not parsed.netloc:
        raise SystemExit("ERROR: LLM_BASE_URL 必须是有效的 https:// 地址")
    return cleaned


def main():
    parser = argparse.ArgumentParser(description="Provision LLM Agent API key to ECS root-only env file")
    parser.add_argument("--ssh-host", default="project51-ecs", help="SSH host alias in ~/.ssh/config")
    parser.add_argument("--rate-per-min", type=int, default=6, help="Per-IP requests per minute limit")
    parser.add_argument("--rate-per-hour", type=int, default=30, help="Per-IP requests per hour limit")
    parser.add_argument("--daily-cap", type=int, default=200, help="Site-wide daily LLM call cap")
    parser.add_argument("--max-tokens", type=int, default=600, help="Max completion tokens per call")
    args = parser.parse_args()

    print("请选择 LLM 平台（直接回车默认选 1. DeepSeek）：")
    for idx, _slug, title, url, model in PRESETS:
        hint = f" ({model})" if model else ""
        print(f"  {idx}. {title}{hint}")

    choice = input("输入序号 [1]: ").strip() or "1"
    matched = next((item for item in PRESETS if item[0] == choice), None)
    if not matched:
        raise SystemExit(f"ERROR: 无效选项 {choice}")

    _idx, provider_slug, title, default_url, default_model = matched
    print(f"\n已选择：{title}")
    if provider_slug == "custom":
        provider_slug = validate_no_newlines("LLM_PROVIDER", prompt_default("平台标识（英文字母/短横线）", "custom"))

    base_url = validate_https_url(prompt_default("API Base URL", default_url))
    model = validate_no_newlines("LLM_MODEL", prompt_default("模型名称", default_model))
    api_key = validate_no_newlines("LLM_API_KEY", getpass.getpass("API Key (输入时不回显): ").strip())

    env_payload = (
        f"LLM_PROVIDER={provider_slug}\n"
        f"LLM_BASE_URL={base_url}\n"
        f"LLM_MODEL={model}\n"
        f"LLM_API_KEY={api_key}\n"
        f"LLM_MAX_TOKENS={args.max_tokens}\n"
        f"AGENT_RATE_LIMIT_PER_MIN={args.rate_per_min}\n"
        f"AGENT_RATE_LIMIT_PER_HOUR={args.rate_per_hour}\n"
        f"AGENT_DAILY_BUDGET_CALLS={args.daily_cap}\n"
    ).encode("utf-8")
    api_key = None

    remote_cmd = (
        "sudo sh -c '"
        "umask 077 && "
        "install -d -m 750 -o root -g project51deploy /etc/project51-classroom && "
        "tmp=$(mktemp /etc/project51-classroom/.llm-agent.env.XXXXXX) && "
        "cat > \"$tmp\" && "
        "chmod 600 \"$tmp\" && "
        "chown root:root \"$tmp\" && "
        "mv -f \"$tmp\" /etc/project51-classroom/llm-agent.env"
        "' && "
        "sudo systemctl restart project51-public-api.service"
    )
    subprocess.run(
        ["ssh", "-o", "BatchMode=yes", args.ssh_host, remote_cmd],
        input=env_payload,
        check=True,
    )
    print("ECS_LLM_ENV_WRITTEN_AND_RESTARTED")

    for _ in range(8):
        time.sleep(1.5)
        check = subprocess.run(
            [
                "ssh",
                "-o",
                "BatchMode=yes",
                args.ssh_host,
                "curl -sS --max-time 3 http://127.0.0.1:8900/api/agent/status",
            ],
            capture_output=True,
            text=True,
        )
        if check.returncode == 0 and check.stdout.strip():
            status = json.loads(check.stdout)
            if status.get("enabled"):
                print(
                    f"ECS_AGENT_OK enabled=True provider={status.get('provider')} "
                    f"model={status.get('model')} per_min={status.get('rate_limit', {}).get('per_min')} "
                    f"daily_cap={status.get('rate_limit', {}).get('daily_cap')}"
                )
                return
    print("ECS_AGENT_RESTARTED_WAIT_CHECK (re-check /api/agent/status in a few seconds)")


if __name__ == "__main__":
    main()
