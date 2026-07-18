# 兼容性参考

[English](compatibility.md)

调研基线：**2026-07-16**。本文描述网关有意提供的公开契约，依据 Agnes
[对话](https://agnes-ai.com/zh-Hans/docs/agnes-20-flash.md)、
[图像](https://agnes-ai.com/zh-Hans/docs/agnes-image-21-flash.md)和
[视频](https://agnes-ai.com/zh-Hans/docs/agnes-video-v20.md)文档，以及 OpenAI
官方当前的
[Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、
[Images](https://developers.openai.com/api/reference/resources/images/methods/generate)与
[Videos](https://developers.openai.com/api/reference/resources/videos/methods/create)
HTTP 参考。

网关不映射模型名。示例使用 Agnes 文档中的模型，但任何 `model` 值都会原样发送。

## 分类含义

| 标记       | 含义                                                         |
| ---------- | ------------------------------------------------------------ |
| 透传       | 完成安全路由所需的基本校验后，不改变语义发送给上游           |
| 转换       | 在 OpenAI 与 Agnes 的字段名或结构间转换                      |
| 丢弃       | 请求上游前移除，并在 `X-Agnes-Gateway-Ignored-Params` 中列出 |
| 部分兼容   | 常见格式可用，但两端无法提供完全相同的语义                   |
| Agnes 扩展 | 接受 Agnes 特有控制项，不能移植到其他 OpenAI 兼容服务        |
| 拒绝       | 无法安全表达的不支持格式会返回 OpenAI 风格 `400`             |

未知可选字段会在剩余请求仍有效时被丢弃；必填数据缺失或非法仍返回 `400`。 OpenAI
标准字段与控制相同含义的 Agnes 扩展冲突时，以 OpenAI 字段为准，
被覆盖路径会列入忽略参数响应头。

## 通用行为

- 每个 `/v1/*` 操作都要求 `Authorization: Bearer <Agnes API key>`。
  生产代码不从环境变量读取 Key，也不持久化凭据。
- 创建/生成请求的 `model` 必填并原样透传；查询使用创建响应返回的任务标识。
- JSON 错误统一包含 OpenAI 风格的 `error.message`、`error.type`、
  `error.param`、`error.code`。在安全范围内保留上游状态码、`Retry-After` 和请求
  ID。
- 网关不自动重试。对于付费或非确定性生成，一个客户端请求不会静默创建替代任务。
- 等待上游响应头的上限为 360 秒；响应头到达前客户端断开会取消上游请求，响应头
  到达后 SSE 与媒体取消通过流式响应体传播。
- CORS 允许任意来源及 `Accept`、`Authorization`、`Content-Type`、`Range`、
  `X-Request-ID` 请求头，但绝不允许浏览器 Cookie credentials。
- 忽略参数元数据最多包含 32 个安全路径，每项不超过 128 个字符；不安全名称显示为
  `<redacted>`，超量部分用 `<truncated>` 表示，防止任意 JSON key
  泄漏或放大响应头。

## 对话补全

`POST /v1/chat/completions`

| 分类       | 字段与行为                                                                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 透传       | `model`、`temperature`、`top_p`、`max_tokens`、`stream`                                                                                                                    |
| 转换       | `max_completion_tokens` → `max_tokens`；`developer` 消息角色 → `system`；每条消息只用 `role` 与 `content` 重建                                                             |
| 部分兼容   | 转换后的消息角色仅支持 `system`、`user`、`assistant`。内容可为字符串，或由 `text`、公开 `image_url` 组成的数组；混合数组中的不支持块会被丢弃，完全没有可用块时返回 `400`。 |
| 部分兼容   | 顶层 `tools`、`tool_choice` 完成容器类型校验后透传。Agnes 记录了工具请求，但网关不支持工具结果消息，因此无法完成 OpenAI 工具结果往返。                                     |
| Agnes 扩展 | `chat_template_kwargs`、`thinking`                                                                                                                                         |
| 丢弃       | 未知顶层控制项与未知消息/内容块嵌套字段会按完整路径报告后移除，包括消息的 `name`、`tool_calls`、`tool_call_id`、音频、refusal、metadata 和图片 detail。                    |
| 拒绝       | `tool` 角色/工具结果消息、其他未记录角色、缺少 `content` 或内容格式非法均返回 `400`；网关不会伪造替代消息。                                                                |

同时提供 `max_completion_tokens` 和 `max_tokens` 时以前者为准。SSE 响应按
具有背压的字节流透传，包括上游 `[DONE]`；网关不合成 usage 分块，也不重新解释
工具调用输出。由于只向上游发送 Agnes 文档确认的消息字段，在 Agnes 记录且网关
实现工具结果消息契约前，调用方应在本接口之外执行工具调用。

## 图像生成

`POST /v1/images/generations`

| 分类       | 字段与行为                                                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 透传       | `model`、`prompt` 与调用方传入的 `size`                                                                                                                     |
| 转换       | 缺省 `size` → `1024x1024`；生成接口的 `response_format: b64_json` → Agnes `return_base64: true`；`response_format: url` → `extra_body.response_format: url` |
| 转换       | `n`（`1`–`10`）→ 并发发起对应数量的 Agnes 请求，并删除上游 `n`；结果保持发起顺序                                                                            |
| 部分兼容   | Agnes 可能将精确像素尺寸标准化为受支持的档位/比例，应以响应元数据为准。                                                                                     |
| Agnes 扩展 | `ratio`、`return_base64` 以及文档确认的 `extra_body.image`/`extra_body.response_format`。未知 `extra_body` 成员作为扩展透传，不具备可移植性。               |
| 丢弃       | Agnes 无法表示的 `background`、`quality`、`style`、`moderation`、`output_compression`、`partial_images`、`stream`、`user` 等 OpenAI 控制项                  |

扇出是原子的：任一上游请求失败时，只返回一个错误，不返回部分 `data`，也不
重试成功或失败分支。聚合响应上限为 64 MiB。

仅当标准 `response_format` 缺失时，才直接接受 Agnes 原生扩展
`return_base64`。一旦提供 `response_format`，标准字段始终优先：网关会删除
`return_base64` 及冲突的 `extra_body.response_format`，即便值相同也逐项报告。
因此，可移植的 OpenAI 客户端应优先使用 `response_format`。

## 图像编辑

`POST /v1/images/edits`

| 分类       | 字段与行为                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 接受输入   | `multipart/form-data` 中重复的 `image` 或 `image[]` 文件；JSON 中 `images`/`image` URL 或 Data URI                                              |
| 转换       | 上传文件 → Data URI；所有输入 → Agnes `extra_body.image`；上游调用 `/images/generations`                                                        |
| 与生成共用 | `model`、`prompt`、`size`、`response_format`、`n`、`ratio` 与原子扇出规则；编辑接口的 `response_format` 始终映射为 `extra_body.response_format` |
| 部分兼容   | 这是 Agnes 图生图，不是像素精确的 OpenAI 蒙版编辑；保留构图属于模型行为。                                                                       |
| 丢弃       | `mask` 及 Agnes 无法表示的 OpenAI 编辑/输出控制项                                                                                               |

网关无状态，因此上传内容在内存中处理。限制为单文件 20 MiB、请求总计 50 MiB、最多
16 张图片。公开 URL 必须能被 Agnes 访问；需要 Cookie 或私有请求头的来源应改用
Data URI。

标准 `image`/`images` 输入会覆盖 Agnes `extra_body.image` 扩展，并报告被覆盖
路径。JSON 也接受包含 `image_url` 的 OpenAI 风格引用对象；本无状态网关无法解析
OpenAI Files，因此其中的 `file_id` 会被报告为已忽略。

## 视频创建

`POST /v1/videos`

| 分类       | 字段与行为                                                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 透传       | `model`、`prompt`                                                                                                                              |
| 转换       | `seconds` 接受 OpenAI 值 `"4"`、`"8"`、`"12"`（也宽容接受 JSON 数字），缺省为 `4`，再转换为 `frame_rate: 24` 及 `num_frames: seconds × 24 + 1` |
| 转换       | `size` 接受 `720x1280`、`1280x720`、`1024x1792`、`1792x1024`，缺省为 `720x1280`，再拆为 Agnes `width` 与 `height`                              |
| 转换       | JSON 或 multipart 的 `input_reference` → Agnes `image`；multipart `input_reference` 文件会转为 Data URI                                        |
| Agnes 扩展 | `image`、`mode`、`seed`、`negative_prompt`、`num_inference_steps`，以及文档确认的 `extra_body.image`、`extra_body.mode` 关键帧控制项           |
| 部分兼容   | Agnes 可能标准化尺寸；`num_frames` 必须 `≤ 441` 且满足 `8n + 1`。时长和尺寸以响应为准。                                                        |
| 丢弃       | 无 Agnes 对应含义的 OpenAI 控制项，并在忽略参数响应头中报告                                                                                    |

OpenAI `seconds`、`size`（包括其默认值）优先于 Agnes 的 `num_frames`、
`frame_rate`、`width`、`height`；输入这四个字段时会报告为已忽略。标准
`input_reference` 同样覆盖 Agnes 的 `image` 与 `extra_body.image` 控制项。
视频生成是异步任务，创建请求返回任务元数据而非视频字节。

## 视频查询与内容下载

`GET /v1/videos/{video_id}` 将公开路径参数视为创建响应中的 Agnes
`task_id`/`id`，并调用 Agnes 旧版 `/videos/{task_id}`。这样无需保存 ID
映射或数据库。响应仍保留 Agnes `video_id`、最终 `url`、进度、标准化尺寸和
标准化时长等扩展字段。

`GET /v1/videos/{video_id}/content` 先获取任务状态。任务成功且存在媒体 URL
后，网关以具有背压的流代理内容，并转发调用方 `Range`。如果媒体存储属于
其他域名，不向该域名发送 Agnes API Key。任务未完成、失败或没有媒体 URL 时， 返回
OpenAI 风格错误。

为兼容客户端，接受 OpenAI `variant=video|thumbnail|spritesheet` 查询参数。 Agnes
只提供成品视频 URL，轻量网关不生成缩略图或精灵图，因此后两种 variant
目前也返回视频内容。

## 响应头

| 响应头                             | 含义                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `X-Request-ID`                     | 网关关联 ID，可安全附在 Bug 报告中                                           |
| `X-Agnes-Gateway-Ignored-Params`   | 最多 32 个安全路径；不安全/过长名称显示 `<redacted>`，超量显示 `<truncated>` |
| `Retry-After`                      | 限流/服务响应提供时予以保留                                                  |
| `Cache-Control: private, no-store` | 防止由凭据产生的 JSON、SSE、URL 与视频字节进入共享缓存或浏览器缓存           |
| `Access-Control-Allow-Origin: *`   | 无 Cookie 的公开 CORS 策略                                                   |

## 已知上游差异与部署限制

- Agnes 尚未记录 Chat SSE 的精确分块 schema、工具结果输入消息和稳定错误体。
  受控实时探测可以调查这些上游格式，但不会因此自动扩展网关公开契约；网关不会
  编造未记录的数据。
- Agnes 图像文档在两个位置描述输入图片；网关明确选择
  `extra_body.image`。文生图和图生图的 Base64 输出控制方式也不同。
- Agnes 同时记录推荐的 `/agnesapi?video_id=…` 与旧版
  `/v1/videos/{task_id}`。本项目使用 task ID 路由，以避免 ID 表或数据库。
- 图片生成可能需要 60–360 秒。Deno Deploy 可能回收实例，multipart 解析
  受内存约束；超出所选 Deno Deploy 套餐限制的负载应使用 Docker。
- 网关不施加账户配额，但 Agnes 或部署平台仍可能返回 `429`、尺寸限制或超时。

受控实时验证流程见[契约测试](contract-testing.zh-CN.md)。Mock 测试通过不表示
未经 Agnes 文档确认的格式已通过真实验证。

按日期记录的脱敏上游观察结果单独保存。最新的
[M2 证据](contract-results/2026-07-18-m2.zh-CN.md)确认了 Chat 与错误信封；由于
首个图片请求以上游 `503` 结束，不对图片契约作出结论。
