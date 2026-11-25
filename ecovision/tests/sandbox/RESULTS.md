# 2026-11-12 软件验证记录

范围：仅沙盒软件；全部输入为模拟。Node v24.19.0；Python 3.13.13；Windows PowerShell。

| 命令 / 检查 | 结果 |
|---|---|
| `node --check sandbox/src/app.mjs` | 退出0 |
| `node --check sandbox/src/model.mjs` | 退出0 |
| `node --test tests/sandbox/model.test.mjs` | 8通过，0失败 |
| `python -B -m unittest discover -s tests/sandbox -p "test_*.py" -v` | 1通过，0失败；5种快照（初始+4预设）匹配公共Schema |
| `python -B -m unittest discover -s tests/integration -p "test_*.py" -v` | 17通过，0失败；只读复核公共合同 |
| 浏览器访问 `http://127.0.0.1:8765/sandbox/` | 连接超时，未完成UI验收 |
| 本机HTTP资源请求 | 受限环境套接字访问被阻止；提权重试仍连接超时。不能宣称HTTP服务验证通过 |
| K230 / STM32 / EC200U实物、授权API、8小时综合测试 | NOT_RUN |

测试先验证控制器缺失导致失败，再实现并通过；另先重现注入改写最近采样值的问题，再修复通过。

已覆盖：3帧进入、30秒无人确认、温度持续与回差、视觉过期/故障60秒、断网保持本地控制、确定性保存/复现、非法输入拒绝、实物适配器未知状态与拒绝控制、输入/采样分离。

未覆盖：浏览器交互与视觉布局、完整REMOTE/LOCAL_OFF、命令幂等/ACK时效、真实云端或硬件。上述通过数量不能作为整机通过依据。
