# EcoVision 风扇控制台

此操作页面使用公共 MQTT 1.0.0 契约。网页读取终端遥测，生成手动开、关和恢复 AUTO 的请求。手动保持 120 秒。页面收到匹配的终端 ACK 后更新命令结果，实际设置的输出随新遥测更新。

## 本机模拟

需要 Node.js 24。下面的命令从网页仓库根目录执行。

```powershell
npm ci --prefix ecovision/cloud
npm test --prefix ecovision/cloud
npm run demo --prefix ecovision/cloud
```

打开 http://127.0.0.1:1880/dashboard/devices 。首次运行的登录信息位于本机 `.secrets/demo.local.json`，其中的 `viewer_user` 和 `viewer_password` 仅用于登录操作台。演示连接本机 TLS Broker 和模拟设备。

## 正式接入

操作台只监听回环地址。使用非版本控制的运行配置，参考 `config/runtime.example.json`，通过 `ECOVISION_CONFIG` 指定配置文件，然后执行 `npm start --prefix ecovision/cloud`。远程入口需要 HTTPS 反向代理，并在配置中设置精确的 `public_origin`。MQTT 证书、账户和授权设备列表由服务端配置，浏览器只访问经过认证的操作台。

正式联调需使用能授权设备订阅自身 `cmd`、发布自身 `ack` 的 Broker，并确认命令路由拒绝保留消息。公开 GitHub Pages 看板独立部署。给网页站构建配置设置 VITE_CONTROL_DASHBOARD_URL 为正式 HTTPS 操作台地址，例如 https://control.example.invalid/dashboard/devices 。此值是公开链接。

更新 `dashboard.vue` 后，执行 `node ecovision/cloud/scripts/build-flow.cjs`，生成对应的 Node-RED 流程。CI 复核生成一致性，并跑状态与本机 TLS/MQTT、认证和控制结果测试。
