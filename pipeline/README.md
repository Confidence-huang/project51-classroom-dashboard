# 端到端模拟数据链路

## 本轮能跑到哪里

电脑上的 `publish.js` 生成“STM32 格式”的模拟快照，经 MQTT 3.1.1/TLS、QoS 1 发往 Broker；`history.js` 订阅同一主题，写入 SQLite 并提供网页历史 API。网页原有 WSS 实时订阅保留，本地一体化网站还会自动读历史。云端 MQTT retained 只保存该主题最新一条；SQLite 保存多条历史，但当前运行在本机，**尚未成为云端数据库**。

`stm32_example.c` 给出板端相同字段的生成逻辑。当前缺队长现有 STM32 固件工程、扩展板 UART 走线和 UART/AT 驱动，所以它只能主机编译演示，不能直接替换现有板卡程序。电脑模拟器直连 Broker，**不经过 EC200U**；此前单独验证过 EC200U 经 4G 向 EMQX 发布测试消息。

## 唯一约定

| 环节 | 参数 |
| --- | --- |
| 主题 | `classroom/room01/telemetry` |
| 模组或电脑 → EMQX | MQTT 3.1.1 over TLS，8883，QoS 1，JSON UTF-8 |
| EMQX → 浏览器 | MQTT over WSS，8084，订阅同一主题 |
| EMQX → 历史服务 | MQTT over TLS，8883，订阅同一主题 |
| 历史服务 → 本地网页 | HTTP GET `/api/telemetry`，同源 `127.0.0.1:8899` |
| 云端最新值 | MQTT retain=true，每主题仅最新一条；不等于历史库 |
| 历史去重 | `device_id + seq`；每次电脑模拟运行生成新模拟设备 ID |

完整 JSON 示例（数值为模拟，不代表实物测量）：

```json
{"schema_version":1,"type":"telemetry","source":"stm32_sim","simulated":true,"device_id":"nucleo-f413zh-sim01","room_id":"room01","seq":1,"captured_at":"2026-11-15T00:00:00Z","people_count":3,"temperature_c":25,"humidity_pct":46,"light_lux":310}
```

`captured_at` 是采样 UTC 时间，`seq` 是设备单调序号；四个单位依次为人、°C、%、lx。未来接入真传感器，保持字段不变，改 `source` 并将 `simulated` 设为 `false`。没有 CO₂ 字段。

板载实测载荷使用 `source:"stm32_micropython_aht20_ldr"`、`simulated:false`、`people_count:null`、`light_lux:null` 和 `light_raw_u16`（0~65535）。AHT20 的温湿度是实测，光敏 ADC 也是实测原码，但未经 lux 标定；网页和 LCD 均显示 ADC 而不是虚假的 lx。历史服务会把旧 `telemetry` 表中的记录只读复制进 `telemetry_v2`，保留旧表，后续写入新表。

## 在本机启动

需要 Node.js 26（历史服务用内置 `node:sqlite`）、PowerShell 7 和 `npm ci`。在本仓库目录运行：

```powershell
npm ci
npm run build
$env:MQTT_URL = 'mqtts://i1103de1.ala.cn-hangzhou.emqxsl.cn:8883'
$env:MQTT_USER = 'classroom_test'
$mqttSecret = Read-Host '输入 MQTT 密码' -AsSecureString
$env:MQTT_PASSWORD = [System.Net.NetworkCredential]::new('', $mqttSecret).Password
$env:MQTT_TOPIC = 'classroom/room01/telemetry'
npm run history
```

历史服务运行时另开一个 PowerShell 7 窗口，重复设置同一组 `MQTT_URL`、`MQTT_USER`、`MQTT_PASSWORD`、`MQTT_TOPIC`，再运行 `npm run simulate`。默认发 3 条、间隔 2 秒，可设 `SIM_COUNT` 和 `SIM_PERIOD_MS`。浏览器打开 `http://127.0.0.1:8899/` 看最新值及历史；`http://127.0.0.1:8899/api/telemetry` 看 JSON 证据。两端日志应分别出现 `PUBLISH_ACK`、`STORED`，API 的最新 `seq` 与发布端一致。重连后 retained 的重复消息会显示 `DUPLICATE`，不会再入库。

密码只通过交互提示进入当前进程环境，不放进文件、Git 或命令行参数。实验完成关闭两个终端，清除当前窗口的 `MQTT_PASSWORD` 环境变量。SQLite 文件 `pipeline/telemetry.sqlite` 被 Git 忽略。

## 实物到货后的替换点

1. STM32 每 5 秒取得 K230 人数和环境数据；没有传感器时继续保留 `simulated:true`。
2. 根据**对应扩展板原理图与现有工程**确认 UART、逻辑电平、共地和供电，接入 `EC200U_PublishMQTT`。AT 驱动至少执行卡就绪/注册/数据附着、TLS 证书与 SNI、`QMTOPEN`、`QMTCONN`、`QMTPUBEX`，等待每一步的异步成功回执并处理重连。实际引脚、证书文件名与已有客户端索引须现场确认；不要把本机示例直接烧进板卡。
3. 先只发布固定模拟 JSON，确认 STM32 串口日志、EC200U QoS 1 回执、EMQX 在线调试订阅、网站相同 `device_id+seq`；最后再把四项数值换成实测。

## 网站部署边界

现有 GitHub Pages 网页可直接用 WSS 接收实时消息，连接信息由使用者在页面输入；静态站点不能安全存储通用 MQTT 密码，也不能运行 SQLite。若要从任何手机查看历史，需要把 `history.js` 部署在有持久磁盘的常在线主机上，给它 HTTPS 域名、只读 API 访问控制和备份；再在网站“历史 API 地址”填该 HTTPS 地址。本地 `127.0.0.1:8899` 只供本机验收，不能填到远端手机。

生产中不应让所有访客共享发布权限。至少把设备发布账号、历史服务只读订阅账号和网页只读账号分开，并为主题设置 ACL。当前账户权限是否已分离，尚未验证。
