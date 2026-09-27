import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'

const app = createApp()

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderedOriginValue(html: string): string | undefined {
  return /var renderedOrigin="([^"]*)"/.exec(html)?.[1]
}

describe('首页接口文档', () => {
  it('无需鉴权即可访问，返回中文文档页', async () => {
    const response = await app.request('/')
    const html = await response.text()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(html).toContain('Agnes OpenAI 兼容网关')
    expect(html).toContain('/v1/chat/completions')
    expect(html).toContain('/v1/images/generations')
    expect(html).toContain('/v1/videos')
  })

  it('示例地址使用请求来源，不再出现 <本网关域名> 占位符', async () => {
    const response = await app.request('/', { headers: { host: 'gateway.example.com', 'x-forwarded-proto': 'https' } })
    const html = await response.text()
    expect(html).not.toContain('本网关域名')
    expect(html).not.toContain('<本网关域名>')
    // 9 个代码示例 + 1 处内联脚本中的 renderedOrigin
    expect(html.split('https://gateway.example.com').length - 1).toBe(10)
  })

  it('示例中的 URL 拼接正确，不出现重复协议', async () => {
    const response = await app.request('/', { headers: { host: 'gateway.example.com', 'x-forwarded-proto': 'https' } })
    const html = await response.text()
    expect(html).not.toMatch(/https?:\/\/https?:\/\//)
    const preBlocks = [...html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)].map((match) => match[1])
    expect(preBlocks.length).toBeGreaterThan(0)
    // 每个示例里的网关地址都必须是完整、可复制的 URL（example.com 等第三方示例不计入）
    const gatewayUrls = preBlocks.flatMap((block) => [...block.matchAll(/https?:\/\/\S+/g)].map((match) => match[0]))
      .filter((raw) => raw.includes('gateway.example.com'))
    expect(gatewayUrls).toHaveLength(9)
    for (const raw of gatewayUrls) expect(raw).toMatch(/^https:\/\/gateway\.example\.com\//)
  })

  it('视频示例使用 <video_id> 占位符，前缀格式单独说明', async () => {
    const response = await app.request('/', { headers: { host: 'gateway.example.com', 'x-forwarded-proto': 'https' } })
    const html = await response.text()
    const blocks = [...html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)].map((match) => match[1])
    const videoCurls = blocks.filter((block) => block.includes('/v1/videos'))
    expect(videoCurls.length).toBeGreaterThan(0)
    for (const block of videoCurls) {
      // <pre> 中的尖括号会被转义为实体
      expect(block).toContain('&lt;video_id&gt;')
      // 示例里不出现带模型前缀的路径，避免误以为要手写前缀
      expect(block).not.toContain('agnes-video-2.5-flash:&lt;video_id&gt;')
      expect(block).not.toContain('agnes-video-2.5-flash:<video_id>')
    }
    // 前缀约定在同一章节中单独说明
    expect(html).toContain('关于 &lt;video_id&gt;')
    expect(html).toContain('&lt;model&gt;:&lt;agnes video_id&gt;')
    expect(html).toContain('model_name')
  })

  it('缺省请求头时回落到请求 URL 的 host', async () => {
    const response = await app.request('/')
    const html = await response.text()
    expect(renderedOriginValue(html)).toBe('http://localhost')
  })

  it('内联脚本按 location.host 动态校正示例地址', async () => {
    const response = await app.request('/', { headers: { host: 'gateway.example.com', 'x-forwarded-proto': 'https' } })
    const html = await response.text()
    expect(html).toContain('location.host')
    expect(html).toContain("location.protocol+'//'+location.host")
    // 用 <pre> 文本替换，不写入 innerHTML
    expect(html).toContain("document.querySelectorAll('pre')")
    expect(html).toContain('<script>')
    expect(html).toContain('</script>')
  })

  it('非法 host 头不会注入脚本', async () => {
    const response = await app.request('/', { headers: { host: 'evil</script><script>alert(1)</script>' } })
    const html = await response.text()
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(renderedOriginValue(html)).toBe('http://localhost')
  })
})
