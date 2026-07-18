# Agnes OpenAI 兼容网关

[![CI](https://github.com/4x25/agnes-compatible-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/4x25/agnes-compatible-gateway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Container](https://img.shields.io/badge/GHCR-container-2496ED)](https://github.com/4x25/agnes-compatible-gateway/pkgs/container/agnes-compatible-gateway)

[English](README.md) · 简体中文

一个非官方、轻量、开源的协议网关，将 Agnes AI 的文本、图像和视频
接口转换为一组明确的 OpenAI 兼容接口。项目面向 Deno Deploy 设计， 同时提供
Docker 镜像。

> [!IMPORTANT]
> 本项目与 OpenAI、Agnes AI 均无隶属关系。“兼容”仅指文档声明的 HTTP
> 接口子集，不代表模型行为相同或全部功能等价。

## 为什么使用本项目？

- **调用方自带 Key（BYOK）：**每个请求携带调用方自己的 Agnes API Key；
  网关生产环境不配置 Key，也不持久化凭据。
- **轻量且无状态：**不提供模型别名、数据库、缓存、队列、计费、网关限流
  和自动重试。
- **便于部署：**基于 Fresh 2 和 Web Standards API，可部署到 Deno Deploy 或
  Docker。
- **兼容边界透明：**明确记录透传、转换、丢弃、部分兼容和 Agnes 扩展字段。

## 支持的接口

| 方法与路径                          | 兼容能力                                      |
| ----------------------------------- | --------------------------------------------- |
| `POST /v1/chat/completions`         | OpenAI Chat Completions 子集；JSON 与上游 SSE |
| `POST /v1/images/generations`       | 文生图；通过原子化并行扇出实现 `n`            |
| `POST /v1/images/edits`             | JSON 图片引用与 OpenAI 风格 multipart 上传    |
| `POST /v1/videos`                   | OpenAI Videos 创建子集；JSON 与 multipart     |
| `GET /v1/videos/{video_id}`         | 查询/轮询 Agnes 异步视频任务                  |
| `GET /v1/videos/{video_id}/content` | 流式下载已完成视频，支持 `Range`              |
| `GET /healthz`                      | 无需认证的本地健康检查，不请求 Agnes          |

`model` 始终必填并原样传给上游。本项目不提供已经废弃的 `/v1/video/generations`
拼写。完整规则见[兼容矩阵](docs/compatibility.zh-CN.md) 与
[OpenAPI 3.1](static/openapi.yaml)。

Chat 消息输入有意小于完整 OpenAI schema：每条消息仅保留 `role` 与 `content`，
支持 `system`、`user`、`assistant`（`developer` 转换为 `system`），拒绝 `tool`
角色/工具结果消息。顶层 `tools`、`tool_choice` 仍为部分兼容的透传控制项。
图片请求中，标准 `response_format` 始终覆盖 Agnes 的 `return_base64` 扩展；
被覆盖及不支持的路径通过 `X-Agnes-Gateway-Ignored-Params` 报告。

## 快速开始

要求 Deno 2.5 或更高版本。

```bash
git clone https://github.com/4x25/agnes-compatible-gateway.git
cd agnes-compatible-gateway
deno install --frozen
deno task dev
```

开发服务器默认位于 `http://localhost:5173`。生产构建默认监听 `8000`：

```bash
deno task build
deno task start
```

仅在需要时修改上游地址：

```bash
export AGNES_BASE_URL="https://apihub.agnes-ai.com/v1"
```

使用你自己的 Agnes Key 调用网关：

```bash
curl http://localhost:8000/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_AGNES_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "agnes-2.0-flash",
    "messages": [{"role": "user", "content": "你好！"}],
    "stream": false
  }'
```

OpenAI 客户端可将 `baseURL` 指向本项目，并将 Agnes Key 作为客户端 API
Key。只有兼容矩阵中声明的接口和字段属于稳定兼容范围。

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: Deno.env.get("AGNES_API_KEY"),
  baseURL: "http://localhost:8000/v1",
});

const response = await client.chat.completions.create({
  model: "agnes-2.0-flash",
  messages: [{ role: "user", content: "你好！" }],
});
```

## Docker

运行已发布镜像时无需把 Key 放入容器：

```bash
docker run --rm -p 8000:8000 \
  ghcr.io/4x25/agnes-compatible-gateway:latest
```

或在本地构建：

```bash
docker compose up --build
```

容器以非 root 用户运行，并提供 `/healthz`。Deno Deploy、新旧镜像标签等
说明见[部署文档](docs/deployment.zh-CN.md)。

## 配置与安全

| 环境变量                      | 默认值                           | 运行时用途                       |
| ----------------------------- | -------------------------------- | -------------------------------- |
| `AGNES_BASE_URL`              | `https://apihub.agnes-ai.com/v1` | Agnes 上游基础地址               |
| `AGNES_API_KEY_ONLY_FOR_TEST` | 未设置                           | 仅实时契约测试；生产代码绝不读取 |

所有 `/v1/*` 生成和查询请求均要求
`Authorization: Bearer <Agnes key>`。网关只会把该请求头转发给配置好的 Agnes
上游。不要把 Key 写入公开网页，也不要把生产网关流量所用 Key 设置为服务端
环境变量。首页测试工具仅在内存中保留 Key。

API 允许跨域请求使用 `Accept`、`Authorization`、`Content-Type`、`Range` 与
`X-Request-ID` 请求头，返回 `Access-Control-Allow-Origin: *`，但绝不启用 Cookie
credentials。错误统一为 OpenAI 风格的
`{ "error": { "message", "type", "param", "code" } }`。
可安全忽略的不支持字段会通过 `X-Agnes-Gateway-Ignored-Params` 响应头报告；
该响应头只显示有界且经过清理的字段路径，不安全名称会脱敏，超量条目会截断。

漏洞报告方式见[安全策略](SECURITY.zh-CN.md)，数据及尺寸限制见
[兼容矩阵](docs/compatibility.zh-CN.md)。

## 项目里程碑

只有对应验收证据存在时才更新状态；仅完成代码修改不等于里程碑完成。

| 里程碑                | 状态                    | 证据 / 完成标准                                                                                                                  |
| --------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| M0 — 可行性与协议决策 | ✅ 已完成（2026-07-16） | [调研基线与兼容决策](docs/compatibility.zh-CN.md)                                                                                |
| M1 — 运行时与核心基础 | ✅ 已完成（2026-07-17） | [CI 验收](https://github.com/4x25/agnes-compatible-gateway/actions/runs/29562152663) 已通过 Deno 2.5.6/2.9.3、Docker 与 Chromium |
| M2 — Chat 与 Images   | 🚧 进行中               | [Chat/错误与图片 URL 实时探测通过；Base64/编辑仍待完成](docs/contract-results/2026-07-18-m2.zh-CN.md)                            |
| M3 — Video 闭环       | 🚧 进行中               | Mock 创建、查询、内容下载与 Range 已通过；仍需真实 Agnes 任务完成并轮询                                                          |
| M4 — 首页与接口测试台 | ✅ 已完成（2026-07-16） | [完整 Chromium/CDP 验收](docs/browser-testing.zh-CN.md) 覆盖双语、五种工作流、六个接口与安全检查                                 |
| M5 — 开源发布就绪     | 🚧 进行中               | 双语文档与工作流已就绪；仍需 Deno Deploy Preview、多架构 GHCR 发布和 `v0.1.0` 验收                                               |

### 本地验收快照 — 2026-07-16

- Deno 2.5.6 与 2.9.3 均使用独立干净副本及外部空缓存，通过
  `deno install --frozen`、格式、lint、类型检查、全部 41 项测试和生产构建。
  测试分为：36 项网关测试、1 项 OpenAI 官方 TypeScript SDK 工作流测试、 1 项
  OpenAPI 契约测试和 3 项 Fresh 路由测试。
- Chromium 146 通过 loopback 假 Agnes 覆盖 Chat SSE 取消/成功、图片生成、
  multipart 图片编辑、文生视频与图生视频；同时验证全部公开接口、视频轮询/
  内容/预览、六种响应式宽度、中英文、键盘与 reduced-motion、Key 不持久化、
  请求脱敏，以及媒体下载不携带 Authorization。
- `deno task test:live` 在两个显式安全开关未同时设置时会按设计失败关闭；
  本次验收未发出任何真实 Agnes 请求。

### CI 验收快照 — 2026-07-17

- [运行 29562152663](https://github.com/4x25/agnes-compatible-gateway/actions/runs/29562152663)
  在 Deno 2.5.6 与 2.9.3 上完成 frozen 安装、格式、lint、类型检查、全部测试及
  生产构建。
- 同一次运行构建了生产 Docker 镜像，并在只读、非 root、移除 capabilities 的
  容器中验证 `/healthz`。
- Chromium 任务在 GitHub 托管环境中重复验证了双语、响应式、在线测试台及凭据
  安全验收。

仍需付费或部署资源的外部验收保持未完成。M2 需要图片 Base64/编辑契约成功证据。 M3
需要真实 Agnes 视频闭环。M5 需要 Deno Deploy Preview、GHCR 多架构发布成功及
`v0.1.0` 正式发布。

## 文档

- [兼容矩阵与已知差异](docs/compatibility.zh-CN.md)
- [部署：Deno Deploy 与 Docker](docs/deployment.zh-CN.md)
- [实时契约测试](docs/contract-testing.zh-CN.md)
- [浏览器 Smoke 测试](docs/browser-testing.zh-CN.md)
- [参与贡献](CONTRIBUTING.zh-CN.md)
- [安全策略](SECURITY.zh-CN.md)
- [变更记录](CHANGELOG.md)

## 参与贡献

欢迎提交 Issue 和 Pull Request。请先阅读[参与贡献](CONTRIBUTING.zh-CN.md)与
[行为准则](CODE_OF_CONDUCT.zh-CN.md)。请勿在公开报告中附带真实 API Key、
私人生成内容或上游私有响应 URL。

## 许可证

[MIT](LICENSE) © 2026 4×25。
