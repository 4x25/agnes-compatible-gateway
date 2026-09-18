# Agnes 3.0 Flash 系列适配证据 — 2026-09-18

[English](2026-09-18-agnes-3-flash-family.md)

状态：**已验收**。

本文只记录有限的状态与结构观察，省略凭据、提示词、任务 ID、响应取值、媒体 URL、
Data URI 与媒体字节。

## 运行信息

| 项目       | 取值                                                                |
| ---------- | ------------------------------------------------------------------- |
| 网关版本   | 基于 `68d450a1e52647eae047c823d518937338d37515` 的工作区构建        |
| Deno       | `2.9.6`                                                             |
| 配置的上游 | 调用方自建的 Agnes HTTPS 反向代理（主机名已隐藏）                    |
| 测试模型   | `agnes-3.0-flash`、`agnes-image-2.5-flash`、`agnes-video-2.5-flash` |
| 输入       | 仓库自带的合成 PNG Data URI 与固定探针提示词                        |
| 重试策略   | 创建请求从不重试，仅重复只读查询                                    |
| 凭据       | 仅注入到显式开启的实时测试进程                                      |

## 测试用例

### 离线套件（已提交、可重复）

| 范围            | 用例数 | 验证内容                                                                                                                              |
| --------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Chat 工具闭环   | 3      | assistant 携带 `tool_calls` 且 `content: null` 时按已文档化字段重建；`tool` 结果消息必须有 `tool_call_id`；非法续接在本地返回 `400`。 |
| Chat 兼容性     | 6      | `developer`→`system`、`max_completion_tokens` 优先级、内容块、忽略参数上报、SSE 字节透传。                                            |
| Video 2.5 转换  | 8      | `seconds` 字符串化、档位/像素 `size` 映射、`aspect_ratio` 优先级、mode 默认值与别名、关键帧/参考媒体、`extra_body` 提升、Flash 限制。 |
| Video 查询      | 5      | 携带 `model_name` 的查询、2.5 ID 不触发旧版回退、`metadata.url` 内容解析、V2.0 ID 行为、旧版回退。                                    |
| Video V2.0 回归 | 5      | 基于帧的 `num_frames`/`frame_rate`/`width`/`height` 映射与 multipart 参考处理保持不变。                                               |
| 图像            | 9      | 生成/编辑映射、`n` 并发扇出、Base64 优先级、multipart Data URI、体积限制。                                                            |
| OpenAI 官方 SDK | 1      | V2.0 与 2.5（含带模型前缀的公开 ID）的 `videos.create`/`retrieve`/`downloadContent` 走真实 HTTP。                                     |
| OpenAPI 文档    | 1      | 已提交契约可解析且只描述公开路由。                                                                                                    |
| Fresh 路由适配  | 3      | 健康检查、CORS 预检、OpenAI 形状的 404/405 中间件。                                                                                   |

### 受控实时探测（`tests/live_contract.ts`）

| 探测      | Scope                                 | 结果                                                                               |
| --------- | ------------------------------------- | ---------------------------------------------------------------------------------- |
| Chat      | `chat`                                | `200`；`agnes-3.0-flash` 返回 OpenAI 兼容信封。                                    |
| Chat SSE  | `chat-sse`                            | `200`；分块结构符合预期。                                                          |
| Chat 工具 | `chat-tools`                          | 工具调用与工具结果两次请求均 `200`；上游接受 assistant `tool_calls` 续接。         |
| 错误      | `errors`                              | `400` 与 `401` 安全 OpenAI 形状错误信封。                                          |
| 图像      | `image`、`image-base64`、`image-edit` | `200`；`agnes-image-2.5-flash` 的 URL、Base64 与 Data URI 编辑信封。               |
| 视频      | `video`                               | `200`；创建信封，随后以 `video_id` + `model_name=agnes-video-2.5-flash` 查询成功。 |

### 网关端到端（`deno task build` + `deno serve`，使用真实 Key）

| 流程       | 请求                                                         | 结果                                                                                             |
| ---------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Chat       | `agnes-3.0-flash` 单条用户消息                               | `200`；`finish_reason: stop`。                                                                   |
| Chat 工具  | 先工具调用，再 assistant `tool_calls` + `tool` 结果          | `200`；先 `finish_reason: tool_calls`，再 `finish_reason: stop` 并给出使用工具结果后的回答。     |
| 文生图     | `agnes-image-2.5-flash`，`size: 2K`、`ratio: 16:9`、URL 输出 | `200`；返回 1 条 URL 结果。                                                                      |
| 图生图     | Data URI `images` + `response_format: b64_json`              | `200`；返回 1 条 Base64 结果。                                                                   |
| 视频创建   | `agnes-video-2.5-flash`、`720P`、`9:16`、关键帧 Data URI     | `200`；公开 `id` 为 `agnes-video-2.5-flash:<task>`，原始 `video_id` 保留。                       |
| 视频查询   | 使用编码后的带模型公开 `id`                                  | `200`；到达 `completed`，`progress: 100`。                                                       |
| 视频下载   | 同一 ID 上 `Range: bytes=0-0`                                | `206`；`content-range: bytes 0-0/<size>`、`content-type: video/mp4`，返回 1 字节。               |
| Flash 限制 | `size: 1080P`、`seconds: 13`、6 张图、4 段音频、`videos`     | 均返回 `400`，`param` 分别为 `size`、`seconds`、`images`、`audios`、`videos`，且不发起上游请求。 |

## 影响实现的上游观察

| 观察                                                                     | 证据                                                             | 对应实现                                             |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------- |
| Video 2.5 拒绝 V2.0 帧参数：`height` 为禁止字段，像素 `size` 无效        | `invalid_request` 且 `param: height`；`size must be one of 720P` | 视频转换按模型家族分派双方言。                       |
| 无状态查询只有在 `model_name` 与创建模型完全一致时才返回结果，否则 `404` | 其他模型字符串查询全部失败                                       | 2.5 公开 ID 携带模型，查询时回填 `model_name`。      |
| 2.5 的 `seconds` 必须是 JSON 字符串                                      | 数字 `seconds` 解析失败                                          | 2.5 始终发送字符串形式。                             |
| 关键帧参考图单边至少 256 像素                                            | `input image side length must be between 256 and 5760 pixels`    | 探针改用 256 像素合成 PNG。                          |
| 视频创建可能瞬时返回 `503`/`video_queue_full`                            | 本次运行中多次创建尝试                                           | 网关透传上游状态，且从不重试创建。                   |
| 本次运行中完成的 2.5 Flash 任务在顶层返回媒体 URL                        | 完成态响应字段                                                   | 网关同时解析顶层 `url` 与文档记载的 `metadata.url`。 |

## 验证命令

```bash
deno task check          # fmt + lint + 类型检查 + 测试发现
deno task test           # 53 passed, 0 failed
RUN_AGNES_LIVE_TESTS=1 AGNES_LIVE_SCOPES=chat,chat-sse,chat-tools,errors,image,image-base64,image-edit deno task test:live
RUN_AGNES_LIVE_TESTS=1 AGNES_LIVE_SCOPES=video deno task test:live
```

本环境未安装 Chromium，因此未在本地运行浏览器冒烟套件；落地页默认模型变更由现有
CI 任务覆盖。

## 局限

- 实时结果取决于 Agnes 账号权限、当前优惠状态以及 2026-09-18 观察到的队列容量。
- 本次观察到的 2.5 完成态使用顶层 `url`；文档记载的 `metadata.url` 形式同样被
  接受，但本次运行未出现该形式。
- `agnes-video-v2.0` 仍由行为不变的 V2.0 方言支持，本次适配未对其做端到端复测；
  其单元测试仍然通过。
