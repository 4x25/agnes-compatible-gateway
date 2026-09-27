const sectionStyle = { margin: '0 0 40px' }
const h2Style = { fontSize: '20px', margin: '0 0 12px', color: '#0f172a' }
const pStyle = { margin: '0 0 12px', color: '#334155' }
const preStyle = {
  margin: '0 0 12px',
  padding: '14px 16px',
  background: '#0f172a',
  color: '#e2e8f0',
  borderRadius: '8px',
  overflowX: 'auto' as const,
  fontSize: '13px',
  lineHeight: 1.6
}
const codeStyle = { background: '#f1f5f9', padding: '1px 5px', borderRadius: '4px', fontSize: '13px' }
const h3Style = { fontSize: '16px', margin: '24px 0 8px', color: '#0f172a' }
const noteStyle = {
  margin: '0 0 12px',
  padding: '10px 14px',
  background: '#f1f5f9',
  borderLeft: '3px solid #94a3b8',
  borderRadius: '4px',
  fontSize: '14px'
}
const tableStyle = { width: '100%', borderCollapse: 'collapse' as const, margin: '0 0 12px', fontSize: '14px' }
const thStyle = { textAlign: 'left' as const, padding: '8px 10px', borderBottom: '2px solid #e2e8f0', color: '#0f172a' }
const tdStyle = { padding: '8px 10px', borderBottom: '1px solid #e2e8f0', color: '#334155', verticalAlign: 'top' as const }

function Code({ children }: { children: string }) {
  return <pre style={preStyle}>{children}</pre>
}

/**
 * `origin` is the gateway's own public origin, derived from the incoming request.
 * It is rendered so the page stays usable without JavaScript; an inline script
 * then re-aligns every occurrence with the browser's `location.host`.
 */
export function Page({ origin }: { origin: string }) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Agnes OpenAI 兼容网关 · 接口文档</title>
        <link rel="icon" href="data:," />
      </head>
      <body style={{ margin: 0, background: '#f8fafc', fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' }}>
        <main style={{ maxWidth: '880px', margin: '0 auto', padding: '48px 24px 80px' }}>
          <header style={{ marginBottom: '40px' }}>
            <h1 style={{ fontSize: '30px', margin: '0 0 12px', color: '#0f172a' }}>Agnes OpenAI 兼容网关</h1>
            <p style={pStyle}>
              把 <code style={codeStyle}>agnes-3.0-flash</code>、<code style={codeStyle}>agnes-image-2.5-flash</code>、
              <code style={codeStyle}>agnes-video-2.5-flash</code> 三个模型适配为 OpenAI 标准端点。未适配的 model 原样透传到上游。
            </p>
            <p style={pStyle}>
              所有 <code style={codeStyle}>/v1/*</code> 端点开放 CORS（<code style={codeStyle}>Access-Control-Allow-Origin: *</code>），
              可直接在浏览器或任意 OpenAI SDK 中调用。API Key 只在内存中转发给上游，不落盘、不记日志。
            </p>
          </header>

          <section style={sectionStyle}>
            <h2 style={h2Style}>鉴权</h2>
            <p style={pStyle}>
              所有 <code style={codeStyle}>/v1/*</code> 请求必须携带 <code style={codeStyle}>Authorization: Bearer &lt;Agnes key&gt;</code>。
              缺失或格式错误返回 <code style={codeStyle}>401</code>；<code style={codeStyle}>x-api-key</code> 等其他鉴权头不被接受。
            </p>
            <Code>{`curl ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer $AGNES_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"agnes-3.0-flash","messages":[{"role":"user","content":"你好"}]}'`}</Code>
            <p style={pStyle}>OpenAI SDK 只需替换 base_url：</p>
            <Code>{`from openai import OpenAI

client = OpenAI(base_url="${origin}/v1", api_key=AGNES_KEY)
client.chat.completions.create(model="agnes-3.0-flash", messages=[{"role": "user", "content": "你好"}])`}</Code>
          </section>

          <section style={sectionStyle}>
            <h2 style={h2Style}>动态 baseUrl（自定义上游）</h2>
            <p style={pStyle}>
              把上游 base 直接拼在网关地址之后作为 <code style={codeStyle}>base_url</code>，请求就会转发到该上游，
              优先级高于服务端配置的 <code style={codeStyle}>AGNES_BASE_URL</code>；鉴权与模型适配等其余行为不变。
            </p>
            <Code>{`from openai import OpenAI

client = OpenAI(base_url="${origin}/https://upstream.example.com/v1", api_key=AGNES_KEY)
client.chat.completions.create(model="agnes-3.0-flash", messages=[{"role": "user", "content": "你好"}])`}</Code>
            <div style={noteStyle}>
              <p style={{ margin: 0, color: '#334155' }}>
                部分 CDN（如 Cloudflare）会把路径中的 <code style={codeStyle}>//</code> 折叠成 <code style={codeStyle}>/</code>，
                此时 <code style={codeStyle}>https:/upstream.example.com/v1</code> 与完整写法等价。
              </p>
            </div>
          </section>

          <section style={sectionStyle}>
            <h2 style={h2Style}>端点一览</h2>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>方法</th>
                  <th style={thStyle}>路径</th>
                  <th style={thStyle}>说明</th>
                </tr>
              </thead>
              <tbody>
                <tr><td style={tdStyle}>POST</td><td style={tdStyle}><code style={codeStyle}>/v1/chat/completions</code></td><td style={tdStyle}>文本对话，支持流式与 <code style={codeStyle}>tools</code> 工具调用</td></tr>
                <tr><td style={tdStyle}>POST</td><td style={tdStyle}><code style={codeStyle}>/v1/images/generations</code></td><td style={tdStyle}>文生图、图生图、多图合成</td></tr>
                <tr><td style={tdStyle}>POST</td><td style={tdStyle}><code style={codeStyle}>/v1/images/edits</code></td><td style={tdStyle}>图像编辑（multipart 上传或 JSON URL/Data URI）</td></tr>
                <tr><td style={tdStyle}>POST</td><td style={tdStyle}><code style={codeStyle}>/v1/videos</code></td><td style={tdStyle}>创建视频生成任务</td></tr>
                <tr><td style={tdStyle}>GET</td><td style={tdStyle}><code style={codeStyle}>/v1/videos/&#123;video_id&#125;</code></td><td style={tdStyle}>查询视频任务</td></tr>
                <tr><td style={tdStyle}>GET</td><td style={tdStyle}><code style={codeStyle}>/v1/videos/&#123;video_id&#125;/content</code></td><td style={tdStyle}>下载视频文件，支持 <code style={codeStyle}>Range</code></td></tr>
                <tr><td style={tdStyle}>GET</td><td style={tdStyle}><code style={codeStyle}>/v1/models</code></td><td style={tdStyle}>模型列表（透传上游）</td></tr>
              </tbody>
            </table>
          </section>

          <section style={sectionStyle}>
            <h2 style={h2Style}>文本：/v1/chat/completions</h2>
            <p style={pStyle}>适配模型 <code style={codeStyle}>agnes-3.0-flash</code>，支持文本与图片 URL / Data URI 输入、流式输出、<code style={codeStyle}>n</code>、<code style={codeStyle}>logprobs</code>、<code style={codeStyle}>response_format</code>。</p>
            <Code>{`curl ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer $AGNES_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "agnes-3.0-flash",
    "messages": [{"role": "user", "content": "用一句话介绍你自己"}],
    "stream": true
  }'`}</Code>
            <p style={pStyle}>图片输入：</p>
            <Code>{`{
  "model": "agnes-3.0-flash",
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "这张图里有什么？"},
      {"type": "image_url", "image_url": {"url": "https://example.com/a.png"}}
    ]
  }]
}`}</Code>
          </section>

          <section style={sectionStyle}>
            <h2 style={h2Style}>工具调用（Function Calling）</h2>
            <p style={pStyle}>使用 OpenAI 现行协议 <code style={codeStyle}>tools</code> + <code style={codeStyle}>tool_choice</code>，返回 <code style={codeStyle}>message.tool_calls</code> 与 <code style={codeStyle}>finish_reason: "tool_calls"</code>，流式分片与并行调用均受支持。</p>
            <Code>{`{
  "model": "agnes-3.0-flash",
  "messages": [{"role": "user", "content": "上海现在天气怎么样？"}],
  "tools": [{
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "获取指定城市当前天气",
      "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}
    }
  }],
  "tool_choice": "auto"
}`}</Code>
            <p style={pStyle}>回灌工具结果时，使用 <code style={codeStyle}>role: "tool"</code> 与 <code style={codeStyle}>tool_call_id</code>：</p>
            <Code>{`{
  "role": "tool",
  "tool_call_id": "call_xxx",
  "content": "{\\"temp_c\\": 18, \\"condition\\": \\"多云\\"}"
}`}</Code>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>行为</th>
                  <th style={thStyle}>说明</th>
                </tr>
              </thead>
              <tbody>
                <tr><td style={tdStyle}><code style={codeStyle}>tool_choice</code></td><td style={tdStyle}><code style={codeStyle}>"auto"</code> / <code style={codeStyle}>"none"</code> / <code style={codeStyle}>"required"</code> / <code style={codeStyle}>{'{"type":"function","function":{"name":"..."}}'}</code></td></tr>
                <tr><td style={tdStyle}><code style={codeStyle}>function.parameters</code></td><td style={tdStyle}>可省略，网关自动补 <code style={codeStyle}>{'{"type":"object","properties":{}}'}</code></td></tr>
                <tr><td style={tdStyle}>工具类型</td><td style={tdStyle}>仅支持 <code style={codeStyle}>"function"</code>；<code style={codeStyle}>"custom"</code> 等类型返回 400</td></tr>
                <tr><td style={tdStyle}>旧版协议</td><td style={tdStyle}><code style={codeStyle}>functions</code> / <code style={codeStyle}>function_call</code> 不受支持，返回 400 并给出改写指引</td></tr>
                <tr><td style={tdStyle}>思维链</td><td style={tdStyle}>上游 <code style={codeStyle}>reasoning_content</code> 不返回，与 OpenAI 规范保持一致</td></tr>
              </tbody>
            </table>
          </section>

          <section style={sectionStyle}>
            <h2 style={h2Style}>图像：/v1/images/generations 与 /v1/images/edits</h2>
            <p style={pStyle}>适配模型 <code style={codeStyle}>agnes-image-2.5-flash</code>。<code style={codeStyle}>size</code> 支持档位（<code style={codeStyle}>1K/2K/3K/4K</code>，默认 <code style={codeStyle}>1024x1024</code>）与精确像素写法；<code style={codeStyle}>n</code> 超过 1 时网关并发扇出（上限 10，任一张失败则整体失败）。</p>
            <Code>{`curl ${origin}/v1/images/generations \\
  -H "Authorization: Bearer $AGNES_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "agnes-image-2.5-flash",
    "prompt": "一只在雪地里的红色狐狸，电影感光线",
    "size": "1024x1024",
    "n": 2,
    "response_format": "url"
  }'`}</Code>
            <p style={pStyle}>编辑 / 合成（multipart，可重复 <code style={codeStyle}>image</code> 字段）：</p>
            <Code>{`curl ${origin}/v1/images/edits \\
  -H "Authorization: Bearer $AGNES_API_KEY" \\
  -F model=agnes-image-2.5-flash \\
  -F prompt="把场景改成雨夜霓虹，保留原构图" \\
  -F size=1024x1024 \\
  -F image=@./input.png`}</Code>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>参数</th>
                  <th style={thStyle}>说明</th>
                </tr>
              </thead>
              <tbody>
                <tr><td style={tdStyle}><code style={codeStyle}>size</code></td><td style={tdStyle}>档位或 <code style={codeStyle}>WIDTHxHEIGHT</code>；非原生尺寸会映射到最近的档位与宽高比</td></tr>
                <tr><td style={tdStyle}><code style={codeStyle}>ratio</code></td><td style={tdStyle}>可选扩展字段，取 <code style={codeStyle}>1:1 3:4 4:3 16:9 9:16 2:3 3:2 21:9</code></td></tr>
                <tr><td style={tdStyle}><code style={codeStyle}>response_format</code></td><td style={tdStyle}><code style={codeStyle}>url</code>（默认）或 <code style={codeStyle}>b64_json</code></td></tr>
                <tr><td style={tdStyle}><code style={codeStyle}>image</code></td><td style={tdStyle}>公网 URL 或 <code style={codeStyle}>data:image/png;base64,...</code>；多张即为多图合成</td></tr>
                <tr><td style={tdStyle}><code style={codeStyle}>mask</code></td><td style={tdStyle}>上游不支持，会被忽略并在响应头 <code style={codeStyle}>x-agnes-warning</code> 中提示</td></tr>
                <tr><td style={tdStyle}><code style={codeStyle}>quality</code> / <code style={codeStyle}>style</code> 等</td><td style={tdStyle}>上游不支持，网关会安全丢弃</td></tr>
              </tbody>
            </table>
          </section>

          <section style={sectionStyle}>
            <h2 style={h2Style}>视频：/v1/videos</h2>
            <p style={pStyle}>适配模型 <code style={codeStyle}>agnes-video-2.5-flash</code>（仅 720P）。创建任务后返回 <code style={codeStyle}>id</code>，查询与下载都使用该 <code style={codeStyle}>id</code>（下文记作 <code style={codeStyle}>&lt;video_id&gt;</code>，格式说明见本节末尾）。</p>
            <Code>{`# 1. 创建任务
curl ${origin}/v1/videos \\
  -H "Authorization: Bearer $AGNES_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "agnes-video-2.5-flash",
    "prompt": "雨后的未来城市街道，霓虹倒映在地面，电影级运镜",
    "size": "1280x720",
    "seconds": "5"
  }'

# 2. 查询任务（建议每 1-2 秒轮询）
curl "${origin}/v1/videos/<video_id>" \\
  -H "Authorization: Bearer $AGNES_API_KEY"

# 3. 下载视频（支持 Range）
curl -L "${origin}/v1/videos/<video_id>/content" \\
  -H "Authorization: Bearer $AGNES_API_KEY" -o out.mp4`}</Code>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>参数</th>
                  <th style={thStyle}>说明</th>
                </tr>
              </thead>
              <tbody>
                <tr><td style={tdStyle}><code style={codeStyle}>size</code></td><td style={tdStyle}>默认 <code style={codeStyle}>720x1280</code>；<code style={codeStyle}>1280x720</code> / <code style={codeStyle}>720x1280</code> / <code style={codeStyle}>1792x1024</code> / <code style={codeStyle}>1024x1792</code> 或 <code style={codeStyle}>"720P"</code>，其他尺寸按最近画幅映射</td></tr>
                <tr><td style={tdStyle}><code style={codeStyle}>seconds</code></td><td style={tdStyle}>4–12 的整数，默认 <code style={codeStyle}>"4"</code></td></tr>
                <tr><td style={tdStyle}><code style={codeStyle}>aspect_ratio</code></td><td style={tdStyle}>可选扩展字段：<code style={codeStyle}>21:9 16:9 4:3 1:1 3:4 9:16</code></td></tr>
                <tr><td style={tdStyle}><code style={codeStyle}>input_reference</code></td><td style={tdStyle}>图片 URL 字符串或 <code style={codeStyle}>{'{"image_url": "https://..."}'}</code>，作为参考图生成</td></tr>
                <tr><td style={tdStyle}><code style={codeStyle}>first_frame</code> / <code style={codeStyle}>last_frame</code></td><td style={tdStyle}>首尾帧控制的公网 URL</td></tr>
                <tr><td style={tdStyle}><code style={codeStyle}>images</code> / <code style={codeStyle}>audios</code></td><td style={tdStyle}>参考模式素材 URL，最多 5 张图 / 3 段音频</td></tr>
                <tr><td style={tdStyle}><code style={codeStyle}>mode</code></td><td style={tdStyle}>可选：<code style={codeStyle}>text</code> / <code style={codeStyle}>keyframe</code> / <code style={codeStyle}>reference</code>，缺省按素材自动推断</td></tr>
                <tr><td style={tdStyle}>Flash 限制</td><td style={tdStyle}>不支持参考视频，二进制上传请改用公网 URL</td></tr>
              </tbody>
            </table>
            <p style={pStyle}>响应遵循 OpenAI 视频对象（<code style={codeStyle}>object: "video"</code>、<code style={codeStyle}>status</code>、<code style={codeStyle}>progress</code>、<code style={codeStyle}>completed_at</code>、<code style={codeStyle}>error</code>）。查询接口返回的 <code style={codeStyle}>size</code> 为按档位推导的默认值，实际画幅以视频文件为准。</p>

            <h3 style={h3Style}>关于 &lt;video_id&gt;</h3>
            <p style={pStyle}>
              通过本网关创建视频时，响应里的 <code style={codeStyle}>id</code> 是 <strong>带模型前缀</strong> 的复合 ID，格式为
              <code style={codeStyle}>&lt;model&gt;:&lt;agnes video_id&gt;</code>，例如
              <code style={codeStyle}>agnes-video-2.5-flash:task_KWZ0ev167X11los8Rx7NKYY1eJlLjCWN</code>
              （<code style={codeStyle}>agnes video_id</code> 即上游返回的原始任务 ID）。请把这个 <code style={codeStyle}>id</code> 原样用于
              <code style={codeStyle}>GET /v1/videos/&lt;video_id&gt;</code> 与
              <code style={codeStyle}>GET /v1/videos/&lt;video_id&gt;/content</code>。
            </p>
            <p style={pStyle}>
              之所以带前缀，是因为上游查询接口需要同时提供 <code style={codeStyle}>model_name</code> 与原始任务 ID，网关用前缀来还原
              <code style={codeStyle}>model_name</code>。前缀属于本项目约定，请不要自行拼接到其他服务上。
            </p>
            <div style={noteStyle}>
              <p style={{ margin: 0, color: '#334155' }}>
                也可以只传上游原始任务 ID（不带 <code style={codeStyle}>&lt;model&gt;:</code> 前缀），此时网关按裸 <code style={codeStyle}>video_id</code> 查询，不附带
                <code style={codeStyle}>model_name</code>；该写法仅在上游能唯一定位任务时可用。作为路径片段时，建议对 <code style={codeStyle}>:</code> 做 URL 编码
                （<code style={codeStyle}>agnes-video-2.5-flash%3Atask_xxx</code>），<code style={codeStyle}>curl</code> 等客户端通常会自动处理。
              </p>
            </div>
          </section>

          <section style={sectionStyle}>
            <h2 style={h2Style}>错误格式</h2>
            <p style={pStyle}>所有错误统一为 OpenAI 错误包络，并保留上游原始 message（含 request id）：</p>
            <Code>{`{
  "error": {
    "message": "images length must not exceed 5",
    "type": "invalid_request_error",
    "param": "images",
    "code": "too_many_images"
  }
}`}</Code>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>状态码</th>
                  <th style={thStyle}>type</th>
                </tr>
              </thead>
              <tbody>
                <tr><td style={tdStyle}>400 / 404 / 422</td><td style={tdStyle}><code style={codeStyle}>invalid_request_error</code></td></tr>
                <tr><td style={tdStyle}>401 / 403</td><td style={tdStyle}><code style={codeStyle}>authentication_error</code></td></tr>
                <tr><td style={tdStyle}>409</td><td style={tdStyle}><code style={codeStyle}>invalid_request_error</code>（如 <code style={codeStyle}>video_not_ready</code>）</td></tr>
                <tr><td style={tdStyle}>429</td><td style={tdStyle}><code style={codeStyle}>rate_limit_error</code></td></tr>
                <tr><td style={tdStyle}>5xx</td><td style={tdStyle}><code style={codeStyle}>api_error</code> / <code style={codeStyle}>upstream_error</code></td></tr>
              </tbody>
            </table>
          </section>

          <section style={sectionStyle}>
            <h2 style={h2Style}>CORS 与安全</h2>
            <p style={pStyle}>
              全站开放跨域：<code style={codeStyle}>Access-Control-Allow-Origin: *</code>，允许 <code style={codeStyle}>Authorization</code> 与
              <code style={codeStyle}>Content-Type</code> 请求头，预检请求返回 204。
            </p>
            <p style={pStyle}>
              网关不保存任何密钥：请求中的 Bearer key 仅在内存中转发给上游，不写入磁盘、不写入日志、不会出现在错误响应中。服务端日志只包含方法、路径、状态码与耗时。
            </p>
          </section>

          <footer style={{ borderTop: '1px solid #e2e8f0', paddingTop: '16px', color: '#64748b', fontSize: '13px' }}>
            <p style={{ margin: 0 }}>
              未适配的 model 会原样透传到上游；未列出的 <code style={codeStyle}>/v1/*</code> 路径返回 404。本项目与 Agnes AI 无隶属关系。
            </p>
          </footer>
        </main>
        <script
          // Rendered server-side from the request origin, then re-aligned in the
          // browser so every example always uses the host the page was loaded from.
          dangerouslySetInnerHTML={{
            __html: `(function(){var gatewayOrigin=location.protocol+'//'+location.host;var renderedOrigin=${JSON.stringify(origin).replace(/</g, '\\u003c')};if(gatewayOrigin===renderedOrigin)return;var blocks=document.querySelectorAll('pre');for(var i=0;i<blocks.length;i++){var block=blocks[i];if(block.textContent&&block.textContent.indexOf(renderedOrigin)!==-1){block.textContent=block.textContent.split(renderedOrigin).join(gatewayOrigin)}}})();`
          }}
        />
      </body>
    </html>
  )
}
