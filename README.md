# 智慧教室实时看板

本仓库保存网页及本机端到端演示代码。网页公开访问时，MQTT 密码由使用者在当前浏览器会话中输入；源码、构建产物和 Git 历史均不得包含密码。

当前已验证的设备链路为 EC200U 通过 4G 向 EMQX Cloud 发布 `link_test` 测试消息。STM32、K230 和环境传感器的实际数据格式仍待团队联调，网页不会把测试消息当成真实测量值。

## 本地运行与发布

1. 运行 `npm ci` 安装锁定的依赖，`npm run dev` 打开本机预览。
2. 运行 `npm run build`，生成要发布的 `docs/` 目录。
3. GitHub Pages 选择 `main` 分支的 `/docs` 目录；网址由平台分配，无需自有域名。
4. 浏览器中点“设置云端连接”，输入 EMQX 账号密码。网页只在当前内存会话使用密码；换一部手机需要在那部手机上重新输入。不要把密码加进源码或浏览器可公开读取的配置。
5. 模拟 STM32 数据发布、本机 SQLite 历史服务及逐段验收方法见 [pipeline/README.md](pipeline/README.md)。本地一体化入口为 `http://127.0.0.1:8899/`。

## 数据约定

- 已验证测试主题：`classroom/demo/ec200u/link_test`，消息 `type` 为 `link_test`。只更新链路测试区，不修改传感器读数。
- 在同一主题从 EMQX 在线调试页发送 `type: manual_test` 时，网页会显示“手动测试已收到”，明确说明这只验证云端到网页，没有经过 EC200U 4G。
- 待团队确认的真实主题默认写为 `classroom/room01/telemetry`，可在连接弹窗修改。只有这个主题中 `type` 为 `telemetry` 的 JSON 消息才会刷新测量值。
- 展示字段：`temperature_c`（°C）、`humidity_pct`（%）、环境光照，以及可选的 `people_count`。板载 AHT20 和 PC5 光敏 ADC 已由 STM32 MicroPython 读到；未标定的光敏值使用 `light_raw_u16`，`light_lux` 填 `null`，网页标注 ADC 原码。K230 未接入时 `people_count` 为 `null`，网页显示“—”。
- 页面本次会话的 MQTT 消息日志保留最近 20 条；接入历史 API 后另显示最近 5 条已存储快照。EMQX retained 仅保存主题最新一条，本机 SQLite 保存演示历史，公开网站的云端历史 API 尚未部署。

## 当前验证边界

已验证 EC200U 经 4G 发布测试消息、EMQX 转发、本网页 WSS 订阅并显示消息。另在公开测试 Broker 上验证了电脑模拟数据发布、SQLite 入库和本地网站历史展示；该模拟验收没有经过 EC200U，也没有替代 EMQX 正式环境验收。真实识别和传感器数据尚需队长提供上报接口与字段。公开网站的查看者可获得网页源码，不能在静态网页中安全保存通用 MQTT 密码；若需要无需输入密码的多人访问，应改用受控后端。
