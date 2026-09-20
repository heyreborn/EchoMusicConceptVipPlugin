# EchoMusic 酷狗概念版 VIP 插件

通过 EchoMusic 当前登录的酷狗账号领取概念版当日 VIP，并可选择升级为畅听会员。

## 功能

- 手动领取当日 VIP
- 刷新当月领取记录和当前 VIP 信息
- 可选启动后自动领取
- 可选领取成功后自动升级畅听会员
- 标题栏“更多”菜单快捷入口

插件通过 `ctx.kugou.user` 复用 EchoMusic 的登录态、设备信息和请求签名，不读取或保存账号 token、Cookie。

## 开发

```bash
pnpm install
pnpm test
pnpm run typecheck
pnpm run build
```

Rslib 将 `src/index.ts` 打包为 EchoMusic 加载的 `dist/index.js`，Rstest 用于测试日期、领取记录解析、错误处理和并发去重。

## 安装

构建后，将整个仓库目录复制到 EchoMusic 插件目录，刷新插件列表并启用“酷狗概念版 VIP”。`dist/index.js`、`manifest.json`、`style.css` 和 `icon.svg` 必须同时存在。

## 注意

- 自动领取和自动升级默认关闭。
- 自动模式无法确认当月领取记录时不会提交领取请求。
- 日期统一按 `Asia/Shanghai` 计算。
- 相关酷狗接口属于测试性质，活动规则或接口可用性可能变化。

## License

MIT
