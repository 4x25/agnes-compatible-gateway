# 参与贡献

[English](CONTRIBUTING.md)

感谢你帮助改进 Agnes OpenAI 兼容网关。贡献应保持服务轻量、无状态、透明，
并确保调用方自带 Agnes API Key 时的安全性。

请遵守[行为准则](CODE_OF_CONDUCT.zh-CN.md)。安全问题应通过
[安全策略](SECURITY.zh-CN.md)中的私密渠道报告，不要提交公开 Issue。

## 修改之前

- 先搜索已有 Issue 和[兼容矩阵](docs/compatibility.zh-CN.md)。
- 新增协议字段时，同时链接当前 OpenAI 与 Agnes 文档，并说明属于透传、转换、
  丢弃、部分兼容或 Agnes 扩展。
- 保持项目边界：不引入服务端 API Key、模型映射、数据库、缓存、持久队列、
  计费、网关限流或生成任务自动重试。
- Issue、fixture、快照、截图、提交和 CI 日志中不得包含真实 Authorization、 API
  Key、私人提示词、Base64 媒体、完整生成媒体 URL 或用户数据。

## 开发环境

使用 Deno 2.5 或更高版本：

```bash
git clone https://github.com/4x25/agnes-compatible-gateway.git
cd agnes-compatible-gateway
deno install --frozen
deno task dev
```

常用检查：

```bash
deno task check
deno task test
deno task test:browser
deno task build
docker compose up --build
```

普通测试必须确定且使用可注入的伪 Agnes 上游，不得要求联网或凭据。执行任何
真实上游探测前，请阅读[实时契约测试](docs/contract-testing.zh-CN.md)；实时测试
要求两个显式环境开关和可丢弃的测试 Key。无额外依赖的
[浏览器 Smoke 测试](docs/browser-testing.zh-CN.md)默认自行启动本地服务；文档还说明
了如何选择其他 Chromium 二进制或测试已经运行的部署。维护者可按
[部署文档](docs/deployment.zh-CN.md)使用独立安全开关启用
`deno task test:deployment`，完成真实 Preview 验收；普通 Pull Request
不要求执行。

## 架构约定

- 协议转换放在与框架无关的 TypeScript 中；涉及网络时接受可注入 `fetch`。 Fresh
  路由保持精简。
- SSE 与媒体必须保留 Web Stream 背压和取消语义，不得仅为检查/重排而缓冲。
- 在网关边界验证必填数据及安全限制。可选不支持字段只有在剩余请求仍有效时
  才能忽略，并必须通过 `X-Agnes-Gateway-Ignored-Params` 报告。
- 归一化错误时不得泄露凭据、请求体、内部堆栈或存储 URL；日志只记录安全的
  运维元数据。
- 导出接口使用 JSDoc；非显然转换与安全决策应有注释，避免复述代码。
- 英文与简体中文文档必须保持行为含义一致。

## 协议修改的测试

至少为转换添加表驱动单元测试，并针对以下场景添加 handler 测试：

- 合法/非法 JSON 或 multipart 输入；
- 上游成功、4xx/5xx、429、错误响应体和传输失败；
- 忽略字段报告与 OpenAI 风格错误；
- 尺寸/数量边界和图片原子扇出；
- 相关接口的 SSE 分块边界/取消，或视频 `Range`；
- 证明 Authorization 只发给配置的 Agnes API 源，不发给媒体存储源。

如果公开字段、路径、状态、响应头或限制发生变化，必须在同一 Pull Request 中 更新
`static/openapi.yaml` 和中英文兼容文档。没有完成标准中要求的验收证据时， 不得把
README 里程碑标为完成。

## Pull Request

1. 保持改动聚焦，并解释兼容决策。
2. 提交信息应清晰；欢迎使用 `feat:`、`fix:`、`docs:`、`test:` 等 Conventional
   Commit 前缀，但不强制。
3. 本地运行全部检查，并在 Pull Request 中附命令和结果。
4. 可见界面变化应附典型移动端/桌面端截图，并移除敏感信息和私密生成媒体。
5. Review 会重点关注安全、兼容透明度、流行为及部署可移植性。

提交贡献即表示你同意按仓库的 [MIT License](LICENSE) 授权。
