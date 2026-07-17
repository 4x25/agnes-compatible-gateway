# 浏览器 Smoke 测试

[English](browser-testing.md)

首页 Smoke 测试直接使用 Chromium 内置的 DevTools Protocol，因此无需引入
Playwright、Puppeteer 或下载浏览器的依赖包。测试会验证：

- 英文与简体中文可双向切换；
- 320、360、430、600、1024、1280 px 视口均无页面级横向溢出，并验证窄屏 Header
  的品牌与操作项可见性；
- locale、API Key 与在线测试控件可按 Tab 顺序到达，具有可见焦点、正确标签及
  button/tab 语义；
- `prefers-reduced-motion: reduce` 下的计算样式会禁用平滑滚动，并实际压缩过渡和
  重复动画；
- 真实提交 Chat SSE、图片生成、multipart 图片编辑、文生视频和图生视频，并完成
  视频轮询与 content 获取；
- 覆盖全部六个公开接口的取消状态、raw request 脱敏、图片/视频预览及下载/打开
  控件；
- 合成 API Key 标记不会进入 `localStorage`、`sessionStorage`、Cookie、渲染文本、
  属性、序列化 DOM 或其他表单字段；
- “清除敏感数据”操作会从密码输入框移除该标记。

标记只在本机随机生成，并非真实 Agnes Key。工作流测试会启动仅监听 loopback 的
fake Agnes，并且只把该 origin 注入脚本管理的网关进程。浏览器请求仍会经过真实网关
handler 与协议转换，但不会到达 Agnes 或其他外部上游。两个 multipart 工作流使用
临时生成的 1 px PNG，清理阶段会将其删除。

## 本地运行

需要 Deno 2.5 或更高版本，以及兼容 Chromium 的浏览器二进制。脚本会从常见的
Linux/macOS/Windows 安装路径及 `PATH` 命令中自动发现浏览器：

```bash
deno task test:browser
```

不添加配置时，脚本会构建当前源码、选择空闲的 loopback 端口、启动 Fresh
生产服务、等待 `/healthz` 就绪并完成断言；无论成功或失败都会关闭服务端与
浏览器。需要时可覆盖浏览器地址：

```bash
CHROMIUM_PATH=/usr/bin/chromium deno task test:browser
```

如需检查已经运行的本地服务、Preview 或生产部署，可设置服务 origin。此模式下
脚本不会启动或关闭服务端。由于无法安全地把外部网关重定向到本机 fake Agnes，
此模式会跳过提交请求的工作台 E2E；语言、视口、键盘、motion 与凭据持久化检查仍会
运行：

```bash
BROWSER_SMOKE_BASE_URL=http://127.0.0.1:8000 \
  CHROMIUM_PATH=/usr/bin/chromium \
  deno task test:browser
```

可选配置：

| 变量                       | 默认值             | 用途                                 |
| -------------------------- | ------------------ | ------------------------------------ |
| `CHROMIUM_PATH`            | 自动发现           | 用 Chromium 路径或命令名覆盖         |
| `BROWSER_SMOKE_BASE_URL`   | 未设置             | 复用指定 origin，不启动本地服务      |
| `BROWSER_SMOKE_PORT`       | 空闲 loopback 端口 | 脚本管理的 Fresh 生产服务端口        |
| `BROWSER_SMOKE_SKIP_BUILD` | 未设置             | 仅在复用已有 `_fresh` 构建时设为 `1` |
| `BROWSER_SMOKE_TIMEOUT_MS` | `600000`           | 各阶段构建、启动、导航和 UI 等待超时 |

进程需要权限运行子进程、监听 loopback、读取 Chromium 二进制、创建临时浏览器
Profile/PNG，并读取以上环境变量。仓库任务使用 `-A`，以便在不同 Deno 版本中保持
一致行为。

## 排错

- 未能自动发现 Chromium 时请设置 `CHROMIUM_PATH`；不要向仓库添加机器专用软链接
  或浏览器二进制。显式覆盖始终优先于内置候选路径和 `PATH`。
- 容器或 root 会话无需额外参数；脚本已传入 Chromium 的 `--no-sandbox` 与
  `--disable-dev-shm-usage`。
- 冷启动或资源受限的构建机可调大 `BROWSER_SMOKE_TIMEOUT_MS`。
- 成功构建后快速复测可用 `BROWSER_SMOKE_SKIP_BUILD=1`；发布验收时应省略该变量，
  避免旧静态资源误通过测试。
- `BROWSER_SMOKE_BASE_URL` 必须是 `http://` 或 `https://` origin，并提供 `/` 和
  `/healthz`。
