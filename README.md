# agnes-compatible-gateway

[Unofficial] OpenAI-compatible gateway for Agnes text, image and video APIs.

把 `agnes-3.0-flash`、`agnes-image-2.5-flash`、`agnes-video-2.5-flash` 适配为 OpenAI 标准端点，
其余 model 原样透传到上游。部署于 Wasmer Edge（正式环境：<https://agnes.wasmer.app>）。

## 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/chat/completions` | 文本对话（流式 / `tools` 工具调用 / 图片输入） |
| POST | `/v1/images/generations` | 文生图、图生图、多图合成（`n` 并发扇出） |
| POST | `/v1/images/edits` | 图像编辑（multipart 或 JSON URL/Data URI） |
| POST | `/v1/videos` | 创建视频任务 |
| GET | `/v1/videos/{video_id}` | 查询视频任务（`video_id` 为 `<model>:<agnes video_id>`） |
| GET | `/v1/videos/{video_id}/content` | 下载视频（支持 `Range`） |
| GET | `/v1/models` | 模型列表（透传） |
| GET | `/` | 中文接口文档页（示例地址按访问域名自动生成） |

所有 `/v1/*` 需要 `Authorization: Bearer <Agnes key>`；密钥只在内存中转发，不落盘、不记日志。
CORS 完全开放（`Access-Control-Allow-Origin: *`）。

### 动态 baseUrl（覆盖上游）

除了服务端环境变量，调用方还可以把上游 base 直接拼在网关地址后面当作 `base_url` 使用：

```
https://example.com/https://upstream.example.com/v1
```

此时请求会转发到 `https://upstream.example.com/v1`，**优先级高于 `AGNES_BASE_URL`**；鉴权、模型适配、
请求体与响应格式等其他行为完全不变。例如视频查询仍按该 base 推导 `<origin><prefix>/agnesapi`。

部分 CDN（如 Cloudflare）会把路径中的 `//` 折叠成 `/`，网关已兼容折叠写法，
`https://example.com/https:/upstream.example.com/v1` 与完整写法等价。

## 开发

```bash
npm install
npm run dev          # 本地开发（http://localhost:3000）
npm run typecheck    # tsc --noEmit
npm run build        # 产出 dist/
npm start            # 运行 dist/index.js
```

环境变量（本地放 `.env`，线上用 Wasmer secret 注入）：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `AGNES_BASE_URL` | 否 | 上游 base，缺省 `https://apihub.agnes-ai.com/v1`；可被请求路径中的动态 baseUrl 覆盖 |
| `PORT` | 否 | 本地监听端口，缺省 3000 |

## 测试

```bash
npm test             # 单元测试（vitest，打桩 fetch）
AGNES_LIVE=1  npm run test:live     # 真实上游联调（读取 .env）
AGNES_ACCEPT=1 npm run test:accept  # 正式环境验收（默认 https://agnes.wasmer.app）
```

测试用例、原始结果与中文报告见 `tests/`、`docs/test-results/`、`docs/test-report.md`。

## 部署

```bash
wasmer app secret create --app "$WASMER_OWNER/$WASMER_APP_NAME" AGNES_BASE_URL "<上游 base>"
npm run deploy:wasmer
```

回滚：`wasmer app version activate <app> <version>`。

本项目与 Agnes AI 无隶属关系。
