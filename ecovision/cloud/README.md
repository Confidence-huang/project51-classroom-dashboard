# EcoVision 风扇控制台

操作台支持风扇关闭、1–5 档和灯环亮灭。选择两项后点「应用手动设置」。终端 ACK 确认请求，遥测显示设置的档位和灯环状态。手动设置保持 120 秒，到期回到 AUTO。也可以提前点「恢复自动模式」。

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

服务端同时接受冻结的 1.0.0 二值报文和 1.1.0 五档报文。先让接收相同主题的严格消费者兼容两版，再在设备上显式启用 1.1.0。收到新鲜的 1.1.0 遥测后，操作台才提供五档。ACK 须与命令的版本一致。回退时先把设备恢复为 1.0.0，验证开关和灯环，再回退消费者。

浏览器提交操作时附上它看到的设备启动标识和控制代次。设备重启或 B1 操作后，服务端拒绝使用旧状态提交的操作，操作者应刷新后重新确认。

正式联调需使用能授权设备订阅自身 `cmd`、发布自身 `ack` 的 Broker，允许控制账号仅向授权设备发布非保留命令，并确认命令主题无历史保留消息。公开 GitHub Pages 看板独立部署。给网页站构建配置设置 VITE_CONTROL_DASHBOARD_URL 为正式 HTTPS 操作台地址，例如 https://control.example.invalid/dashboard/devices 。此值是公开链接。

更新 `dashboard.vue` 后，执行 `node ecovision/cloud/scripts/build-flow.cjs`，生成对应的 Node-RED 流程。CI 复核生成一致性，并跑状态与本机 TLS/MQTT、认证和控制结果测试。
