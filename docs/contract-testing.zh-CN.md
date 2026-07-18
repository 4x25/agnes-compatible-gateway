# Agnes 实时契约测试

[English](contract-testing.md)

普通测试套件使用可注入的伪 Agnes 服务，结果确定、无需联网或 API Key，可安全 用于
Pull Request。实时测试只用于确认 Agnes 文档没有完整说明的上游行为。

## 安全开关

除非**同时**满足以下条件，否则实时测试必须拒绝启动：

1. `RUN_AGNES_LIVE_TESTS=1`
2. `AGNES_API_KEY_ONLY_FOR_TEST` 含非空、可丢弃的 Agnes 测试 Key

设置两个值后运行专用任务；该任务不会加载 `.env`：

```bash
read -rsp "一次性 Agnes 测试 Key：" AGNES_API_KEY_ONLY_FOR_TEST
printf '\n'
export AGNES_API_KEY_ONLY_FOR_TEST
RUN_AGNES_LIVE_TESTS=1 deno task test:live
unset AGNES_API_KEY_ONLY_FOR_TEST
```

静默读取可避免 Key 进入 Shell 历史与终端输出。

脚本特意命名为 `tests/live_contract.ts`，所以普通 `deno task test` 的自动发现和
CI 不会执行它，也不会读取测试 Key 变量。脚本只接受 HTTPS 上游地址、禁止重定向，
并且只输出有长度限制的字段/类型摘要，不输出响应值。`.env.example` 只记录空值/
禁用状态的占位符；不得把非空 Key 或已启用开关写入该文件、GitHub Actions、
Docker、Deno Deploy、测试快照或 Issue。测试失败时也不得打印 Key。

该任务直连 Agnes，不经过网关。尤其是 `chat-tools` 只用于记录 Agnes 尚未完整
说明的上游契约；即使探测通过，也不表示 `tool` 角色/工具结果消息进入网关公开
兼容子集。网关目前只接受 `system`、`user`、`assistant` 消息，并将 `developer`
转换为 `system`。

## 选择探测项

`AGNES_LIVE_SCOPES` 是逗号分隔的允许列表，默认只运行开销最小的 `chat`。
可用值如下：

| Scope          | 上游任务                                                        |
| -------------- | --------------------------------------------------------------- |
| `chat`         | 一次极短的非流式补全                                            |
| `chat-sse`     | 一次极短的流式补全；验证 UTF-8 事件与 `[DONE]`                  |
| `chat-tools`   | 两次短补全，覆盖强制工具调用及对应的 `tool` 结果消息            |
| `errors`       | 固定空 JSON 的 400 请求，以及使用固定假 Token 的 401 请求       |
| `image`        | 一次 1K、URL 输出的文生图                                       |
| `image-base64` | 一次 1K、Base64 输出的文生图                                    |
| `image-edit`   | 一次 1K、Data URI 输入及 Base64 输出的图生图                    |
| `video`        | 创建一个最小 9 帧的 Data URI 图生视频任务，再通过 video ID 查询 |
| `all`          | 上述全部探测；必须单独使用该值                                  |

例如，仅显式验证目前存在歧义的两个图片契约：

```bash
read -rsp "一次性 Agnes 测试 Key：" AGNES_API_KEY_ONLY_FOR_TEST
printf '\n'
export AGNES_API_KEY_ONLY_FOR_TEST
RUN_AGNES_LIVE_TESTS=1 \
  AGNES_LIVE_SCOPES=image-base64,image-edit \
  deno task test:live
unset AGNES_API_KEY_ONLY_FOR_TEST
```

在 `video` scope 下设置 `AGNES_LIVE_VIDEO_WAIT_FOR_COMPLETION=1`，脚本会轮询
同一个已创建任务直到终态、验证最终 URL，并且在不转发 Agnes Key 的情况下用
`Range: bytes=0-0` 请求首字节；不设置时只查询一次并验证异步任务信封。可分别通过
`AGNES_LIVE_CHAT_MODEL`、`AGNES_LIVE_IMAGE_MODEL` 与 `AGNES_LIVE_VIDEO_MODEL`
覆盖模型名，默认值为本仓库所引用 Agnes 文档中的模型。 `AGNES_BASE_URL` 默认值为
`https://apihub.agnes-ai.com/v1`。

使用最小权限、可丢弃的账户，探测后轮换或撤销 Key。实时测试可能产生付费的
文本、图片或视频任务，执行前应核对 Agnes 当时的价格和配额。生成请求绝不重试；
视频探测只会在通过文档推荐的 `/agnesapi` 读取新 video ID 暂时返回 `404` 时重试。

## 覆盖范围与人工检查清单

只记录日期、Agnes 请求 ID、状态和脱敏的结构摘要；不得记录提示词、Base64
数据、完整媒体 URL 或凭据。

自动 scope 覆盖 Chat JSON、基础 SSE 分帧、强制工具调用与工具结果往返、安全的
400/401 信封形态、文生图 URL/Base64、Data URI 图像编辑，以及 Data URI 视频
创建/查询。显式等待视频完成时，还会覆盖最终媒体 URL 和字节范围行为。`errors`
scope 绝不输出错误正文值；其中 401 请求使用固定假 Token，不使用一次性有效 Key。

以下项目仍需人工观察或未来单独设计探测；本脚本**不声称**已经覆盖：

- SSE 流中的工具调用 delta；
- 公共 URL 图生图输入及历史精确尺寸标准化；
- 不同模型档位下的视频状态变化与响应 `seconds`/`size`；
- 由账户配额触发的 429 与非预期 Agnes 5xx。

不得为了测试而故意触发 429 或 5xx，也不得把错误正文粘贴到日志或 Issue。如果
运行中自然遇到，只保留状态、安全的响应头名称、脱敏请求 ID 和字段/类型形态。

不得将实时测试加入普通 CI 或 Fork Pull Request。维护者可在受保护环境手动
执行，并且只能在对应里程碑中链接脱敏结果。

## 已记录证据

- [2026-07-18 M2 验收](contract-results/2026-07-18-m2.zh-CN.md)：Chat、SSE、
  工具、安全错误信封、图片 URL/Base64 输出和 Data URI 图片编辑全部通过。文档规定
  的 `return_base64` 实际返回 URL，因此已提交的网关与实时 scope 均改用验证通过的
  `extra_body.response_format: b64_json` 映射。
