# 部署

[English](deployment.md)

本项目是无状态网关。部署环境需要能够通过 HTTPS 访问 Agnes，但**不需要**
数据库、缓存、队列、持久卷或服务端 API Key。

## Deno Deploy（当前平台）

以下步骤适用于 [console.deno.com](https://console.deno.com) 的新版 Deno
Deploy，而不是 Deploy Classic。Deno 官方文档说明 Deploy Classic 将于
**2026-07-20** 停止服务。

1. Fork 本仓库，在 Deno Deploy 组织中创建新 App。
2. 通过 Deno Deploy GitHub 集成关联 Fork。
3. 选择 **Fresh** Framework Preset；Fresh 不需要额外平台适配器。
4. 确认检测到的安装命令是 `deno install --frozen`，构建命令是
   `deno task build`。Preset 应配置 Fresh 动态运行时；不要把本 API 部署为
   静态站点。
5. 保持 `AGNES_BASE_URL` 未设置即可使用
   `https://apihub.agnes-ai.com/v1`；如需连接运营者控制的 Agnes 兼容上游， 可在
   Production 与 Development Context 中设置普通环境变量。
6. 不要在 Deno Deploy 设置 `AGNES_API_KEY_ONLY_FOR_TEST`。
7. 创建 App，检查 Warm up 日志，然后先访问 Preview URL 的 `/healthz`，
   验证后再发布。

Deno Deploy 会为构建设置部署标识；每个 Docker 镜像也会设置非空
`DENO_DEPLOYMENT_ID`，防止 Fresh 跨版本复用旧快照。

### Deno Deploy 注意事项

- multipart 输入在实例内存中读取。网关拒绝单文件超过 20 MiB、请求体超过 50 MiB
  或图片超过 16 个的请求。
- 图片请求可能持续 60–360 秒，视频内容也可能较大。实际最长时间、内存、
  出站流量和实例生命周期取决于 Deno Deploy 套餐。应在 Preview 环境验证，
  平台限制不足时使用 Docker。
- `/healthz` 只确认进程可用，不验证 Agnes Key 或具体模型健康状态；健康检查
  有意避免消耗调用方配额。
- 浏览器可通过 CORS 调用。公开部署意味着访问者可通过你的域名发送其 Agnes
  Key，请为实际部署提供合适的隐私声明。

只有真实 Preview 通过健康检查、Chat SSE、图片上传和视频轮询后，相关里程碑
才能标记完成；仓库 CI 通过不能替代这一结果。

### 自动化 Preview 验收

显式启用的部署探测通过网关公开接口执行上述检查，而不是直连 Agnes。默认只运行
不计费的 `health` scope，并拒绝重定向或非 HTTPS 部署地址；仅本地诊断允许显式
loopback HTTP。核对当前上游价格后，使用可丢弃、由调用方拥有的 Agnes Key 执行
完整验收：

```bash
read -rsp "一次性 Agnes 测试 Key：" AGNES_API_KEY_ONLY_FOR_TEST
printf '\n'
export AGNES_API_KEY_ONLY_FOR_TEST
RUN_DEPLOYMENT_LIVE_TESTS=1 \
  DEPLOYMENT_SMOKE_BASE_URL=https://your-preview.example \
  DEPLOYMENT_SMOKE_SCOPES=all \
  deno task test:deployment
unset AGNES_API_KEY_ONLY_FOR_TEST
```

可选 scope 为 `health`、`chat-sse`、`image-upload` 和 `video`；`all` 必须单独
使用。脚本按顺序执行，绝不重试生成请求，只输出状态码、脱敏请求 ID 和有界的
字段/类型结构。它验证 CORS 与缓存控制、Chat SSE 终止、真实 multipart 编辑、
视频终态轮询，以及通过网关内容接口执行的 `Range: bytes=0-0`。脚本不会输出 Key、
提示词、ID、URL、Base64 或媒体字节，也不会进入普通 CI。

## 已发布 Docker 镜像

版本镜像发布到：

```text
ghcr.io/4x25/agnes-compatible-gateway
```

生产环境应使用不可变版本标签：

```bash
docker run --detach \
  --name agnes-gateway \
  --restart unless-stopped \
  --read-only \
  --tmpfs /tmp:size=64m \
  --publish 8000:8000 \
  ghcr.io/4x25/agnes-compatible-gateway:0.1.0
```

镜像支持 `linux/amd64`、`linux/arm64`，以无特权 `deno` 用户运行；由发布
工作流构建时包含 OCI provenance 与 SBOM。部署前应确认目标标签真实存在； Git Tag
工作流成功前，本项目不会声称对应版本已发布。

### 本地构建

```bash
docker compose up --build
curl --fail http://localhost:8000/healthz
```

或直接构建，并传入唯一部署标识：

```bash
docker build \
  --build-arg DENO_DEPLOYMENT_ID="local-$(git rev-parse --short HEAD)" \
  --tag agnes-compatible-gateway:local .
docker run --rm -p 8000:8000 agnes-compatible-gateway:local
```

调用方 API Key 不应写入镜像、Compose 文件或容器环境变量，必须通过 HTTP
Authorization 请求头提供。

## 配置

| 环境变量                      | 必填             | 默认值                           | 说明                                                                           |
| ----------------------------- | ---------------- | -------------------------------- | ------------------------------------------------------------------------------ |
| `AGNES_BASE_URL`              | 否               | `https://apihub.agnes-ai.com/v1` | 自动处理末尾斜杠。调用方 Key 会发送到这里，因此只能设为运营者信任/控制的上游。 |
| `AGNES_API_KEY_ONLY_FOR_TEST` | 生产环境绝不设置 | 未设置                           | 只供明确启用的实时契约测试读取。                                               |
| `RUN_AGNES_LIVE_TESTS`        | 生产环境绝不设置 | 未设置                           | 必须等于 `1`，作为上游实时测试的第二道安全开关。                               |
| `RUN_DEPLOYMENT_LIVE_TESTS`   | 生产环境绝不设置 | 未设置                           | 必须等于 `1`，外部部署探测才可运行。                                           |
| `DEPLOYMENT_SMOKE_BASE_URL`   | 仅测试进程       | 未设置                           | 已运行网关的显式 HTTPS Origin。                                                |
| `DEPLOYMENT_SMOKE_SCOPES`     | 仅测试进程       | `health`                         | 逗号分隔的部署探测项，或单独使用 `all`。                                       |

## 反向代理与运维

- Docker 部署暴露到互联网前必须终止 TLS；应用在容器内监听 HTTP。
- 保持流式传输：关闭 Chat SSE 和视频内容路由的响应缓冲；代理超时应覆盖
  长时间图片生成。
- 视频内容路由需转发 `Range`，并保留 `206`、`Content-Range`、
  `Accept-Ranges`、`Content-Length`。
- 不要记录 Authorization、multipart 请求体、提示词、Base64 媒体或最终媒体
  URL。应用日志仅包含请求 ID 的单向哈希、路由、状态与耗时。
- 可针对持续的 5xx/429 比率与延迟告警，但单次 Agnes 429 不代表网关不健康。
- 回滚时部署上一个不可变 GHCR 版本。服务没有存储，不涉及数据迁移。

## 发布镜像

推送符合 `v*.*.*` 的版本 Git Tag 会启动发布工作流，为两个架构发布语义版本、
主/次版本、SHA，以及仅稳定版本使用的 `latest` 标签。工作流通过 GitHub OIDC
生成证明并发布到 GitHub Container Registry，无需设置镜像仓库密码 Secret。

打 Tag 前必须保证 CI 全绿、更新 `CHANGELOG.md`、核对两份 README 里程碑、
使用一次性测试 Key 执行可选契约测试，并完成 Deno Deploy Preview 清单。
