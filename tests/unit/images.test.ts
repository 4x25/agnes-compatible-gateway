import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import { resolveImageSize } from '../../src/lib/images.js'
import { installFetchMock, jsonResponse, proxyBaseUrl } from '../helpers/mock.js'

const app = createApp()

afterEach(() => {
  vi.unstubAllGlobals()
})

function generate(body: Record<string, unknown>) {
  return app.request('/v1/images/generations', {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

function imagePayload(url: string, created = 1700000000) {
  return { created, data: [{ url, b64_json: '', revised_prompt: '' }], task_id: 'task_1' }
}

describe('尺寸映射', () => {
  it('缺省 size 映射为 1K + 1:1（1024x1024）', () => {
    expect(resolveImageSize(undefined, undefined)).toEqual({ tier: '1K', ratio: '1:1' })
    expect(resolveImageSize('auto', undefined)).toEqual({ tier: '1K', ratio: '1:1' })
  })

  it('档位写法直接使用档位', () => {
    expect(resolveImageSize('2K', undefined)).toEqual({ tier: '2K', ratio: '1:1' })
    expect(resolveImageSize('4K', '16:9')).toEqual({ tier: '4K', ratio: '16:9' })
  })

  it('精确命中原生尺寸时使用对应档位与画幅', () => {
    expect(resolveImageSize('2624x1472', undefined)).toEqual({ tier: '2K', ratio: '16:9' })
    expect(resolveImageSize('864x1152', undefined)).toEqual({ tier: '1K', ratio: '3:4' })
  })

  it('非原生尺寸按最近画幅与档位映射', () => {
    expect(resolveImageSize('1920x1080', undefined)).toEqual({ tier: '2K', ratio: '16:9' })
    expect(resolveImageSize('1000x1000', undefined)).toEqual({ tier: '1K', ratio: '1:1' })
    expect(resolveImageSize('1024x768', undefined)).toEqual({ tier: '1K', ratio: '4:3' })
    expect(resolveImageSize('100x100', undefined)).toEqual({ tier: '1K', ratio: '1:1' })
    expect(resolveImageSize('5000x5000', undefined)).toEqual({ tier: '4K', ratio: '1:1' })
  })

  it('ratio 覆盖推导结果', () => {
    expect(resolveImageSize('1024x1024', '16:9')).toEqual({ tier: '1K', ratio: '16:9' })
  })

  it('非法输入抛出 400', () => {
    expect(() => resolveImageSize('huge', undefined)).toThrowError(/Unsupported/)
    expect(() => resolveImageSize('1024x1024', '5:7')).toThrowError(/ratio/)
  })
})

describe('文生图适配', () => {
  it('请求体只包含上游白名单字段，并丢弃 quality 等未知字段', async () => {
    const mock = installFetchMock(() => jsonResponse(imagePayload('https://cdn.test/a.png')))
    const response = await generate({
      model: 'agnes-image-2.5-flash',
      prompt: 'a red apple',
      size: '1024x1024',
      quality: 'high',
      style: 'vivid',
      user: 'u-1'
    })
    expect(response.status).toBe(200)
    const sent = mock.calls[0]!.body
    expect(Object.keys(sent).sort()).toEqual(['extra_body', 'model', 'prompt', 'ratio', 'size'])
    expect(sent.quality).toBeUndefined()
    expect(sent.size).toBe('1K')
    expect(sent.ratio).toBe('1:1')
    expect(sent.extra_body).toEqual({ response_format: 'url' })
    expect(mock.calls[0]!.url).toBe(`${proxyBaseUrl()}/images/generations`)
  })

  it('响应归一化为 {created, data} 并丢弃 task_id，空串变 null', async () => {
    installFetchMock(() => jsonResponse(imagePayload('https://cdn.test/a.png')))
    const response = await generate({ model: 'agnes-image-2.5-flash', prompt: 'x' })
    const body = await response.json()
    expect(Object.keys(body).sort()).toEqual(['created', 'data'])
    expect(body.data[0]).toEqual({ url: 'https://cdn.test/a.png', b64_json: null, revised_prompt: null })
  })

  it('b64_json 输出走 return_base64（无输入图时）', async () => {
    const mock = installFetchMock(() => jsonResponse({ created: 1, data: [{ url: '', b64_json: 'AAAA', revised_prompt: '' }] }))
    const response = await generate({ model: 'agnes-image-2.5-flash', prompt: 'x', response_format: 'b64_json' })
    const body = await response.json()
    expect(mock.calls[0]!.body.return_base64).toBe(true)
    expect(mock.calls[0]!.body.extra_body.response_format).toBe('b64_json')
    expect(body.data[0].b64_json).toBe('AAAA')
    expect(body.data[0].url).toBeNull()
  })

  it('图生图把输入图放进 extra_body.image', async () => {
    const mock = installFetchMock(() => jsonResponse(imagePayload('https://cdn.test/b.png')))
    await generate({
      model: 'agnes-image-2.5-flash',
      prompt: 'make it blue',
      image: ['https://example.com/in.png', 'data:image/png;base64,AAAA'],
      response_format: 'b64_json'
    })
    const sent = mock.calls[0]!.body
    expect(sent.extra_body.image).toEqual(['https://example.com/in.png', 'data:image/png;base64,AAAA'])
    expect(sent.return_base64).toBeUndefined()
  })

  it('prompt 缺失返回 400 且不调用上游', async () => {
    const mock = installFetchMock(() => jsonResponse({}))
    const response = await generate({ model: 'agnes-image-2.5-flash' })
    expect(response.status).toBe(400)
    expect((await response.json()).error.param).toBe('prompt')
    expect(mock.calls).toHaveLength(0)
  })

  it('非法 response_format / n 返回 400', async () => {
    installFetchMock(() => jsonResponse({}))
    expect((await generate({ model: 'agnes-image-2.5-flash', prompt: 'x', response_format: 'png' })).status).toBe(400)
    expect((await generate({ model: 'agnes-image-2.5-flash', prompt: 'x', n: 0 })).status).toBe(400)
    expect((await generate({ model: 'agnes-image-2.5-flash', prompt: 'x', n: 11 })).status).toBe(400)
  })

  it('未适配模型原样透传', async () => {
    const mock = installFetchMock(() => jsonResponse(imagePayload('https://cdn.test/c.png')))
    const payload = { model: 'agnes-image-2.1-flash', prompt: 'x', size: '1024x768', tags: ['img2img'] }
    const response = await generate(payload)
    expect(response.status).toBe(200)
    expect(mock.calls[0]!.body).toEqual(payload)
    expect(await response.json()).toEqual(imagePayload('https://cdn.test/c.png'))
  })
})

describe('n 并发扇出', () => {
  it('n=3 时发出 3 个不含 n 的请求并按顺序合并', async () => {
    let counter = 0
    const mock = installFetchMock(() => {
      counter += 1
      return jsonResponse({ created: 1700000000, data: [{ url: `https://cdn.test/${counter}.png`, b64_json: '', revised_prompt: '' }] })
    })
    const response = await generate({ model: 'agnes-image-2.5-flash', prompt: 'x', n: 3 })
    const body = await response.json()
    expect(mock.calls).toHaveLength(3)
    for (const call of mock.calls) expect(call.body.n).toBeUndefined()
    expect(body.data.map((item: any) => item.url)).toEqual(['https://cdn.test/1.png', 'https://cdn.test/2.png', 'https://cdn.test/3.png'])
    expect(body.created).toBe(1700000000)
  })

  it('并发上限为 4', async () => {
    const mock = installFetchMock(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return jsonResponse({ created: 1, data: [{ url: 'https://cdn.test/x.png' }] })
    })
    const response = await generate({ model: 'agnes-image-2.5-flash', prompt: 'x', n: 10 })
    expect(response.status).toBe(200)
    expect(mock.calls).toHaveLength(10)
    expect(mock.maxConcurrent).toBeLessThanOrEqual(4)
  })

  it('任一张失败则整体失败且不返回部分结果', async () => {
    let counter = 0
    installFetchMock(() => {
      counter += 1
      if (counter === 2) return jsonResponse({ error: { message: 'content policy violation', code: 'invalid_request' } }, 400)
      return jsonResponse(imagePayload(`https://cdn.test/${counter}.png`))
    })
    const response = await generate({ model: 'agnes-image-2.5-flash', prompt: 'x', n: 3 })
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.data).toBeUndefined()
    expect(body.error.message).toBe('content policy violation')
  })

  it('n=1 时沿用上游 created', async () => {
    installFetchMock(() => jsonResponse(imagePayload('https://cdn.test/a.png', 123456)))
    const body = await (await generate({ model: 'agnes-image-2.5-flash', prompt: 'x' })).json()
    expect(body.created).toBe(123456)
    expect(body.data).toHaveLength(1)
  })
})

describe('图像编辑 /v1/images/edits', () => {
  it('multipart 多文件转 Data URI 并走 generations', async () => {
    const mock = installFetchMock(() => jsonResponse(imagePayload('https://cdn.test/edited.png')))
    const form = new FormData()
    form.set('model', 'agnes-image-2.5-flash')
    form.set('prompt', 'make it night')
    form.set('size', '1024x1024')
    form.append('image', new File([new Uint8Array([137, 80, 78, 71])], 'a.png', { type: 'image/png' }))
    form.append('image', new File([new Uint8Array([1, 2, 3])], 'b.png', { type: 'image/png' }))

    const response = await app.request('/v1/images/edits', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test' },
      body: form
    })
    expect(response.status).toBe(200)
    const sent = mock.calls[0]!.body
    expect(mock.calls[0]!.url).toBe(`${proxyBaseUrl()}/images/generations`)
    expect(sent.extra_body.image).toHaveLength(2)
    expect(sent.extra_body.image[0]).toMatch(/^data:image\/png;base64,/)
    expect(sent.extra_body.response_format).toBe('url')
    await expect(response.json()).resolves.toMatchObject({ data: [{ url: 'https://cdn.test/edited.png' }] })
  })

  it('mask 被忽略并返回告警头', async () => {
    installFetchMock(() => jsonResponse(imagePayload('https://cdn.test/edited.png')))
    const form = new FormData()
    form.set('model', 'agnes-image-2.5-flash')
    form.set('prompt', 'make it night')
    form.append('image', new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }))
    form.set('mask', new File([new Uint8Array([2])], 'm.png', { type: 'image/png' }))

    const response = await app.request('/v1/images/edits', { method: 'POST', headers: { authorization: 'Bearer sk-test' }, body: form })
    expect(response.status).toBe(200)
    expect(response.headers.get('x-agnes-warning')).toContain('mask')
  })

  it('JSON 形式支持 URL 与 data URI', async () => {
    const mock = installFetchMock(() => jsonResponse(imagePayload('https://cdn.test/edited.png')))
    const response = await app.request('/v1/images/edits', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'agnes-image-2.5-flash',
        prompt: 'combine',
        image: ['https://example.com/a.png', 'data:image/png;base64,AAAA']
      })
    })
    expect(response.status).toBe(200)
    expect(mock.calls[0]!.body.extra_body.image).toEqual(['https://example.com/a.png', 'data:image/png;base64,AAAA'])
  })

  it('缺少图像返回 400', async () => {
    const mock = installFetchMock(() => jsonResponse({}))
    const response = await app.request('/v1/images/edits', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'agnes-image-2.5-flash', prompt: 'x' })
    })
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('missing_image')
    expect(mock.calls).toHaveLength(0)
  })

  it('非适配模型返回 400 model_not_supported', async () => {
    const mock = installFetchMock(() => jsonResponse({}))
    const response = await app.request('/v1/images/edits', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'agnes-image-2.1-flash', prompt: 'x', image: ['https://example.com/a.png'] })
    })
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('model_not_supported')
    expect(mock.calls).toHaveLength(0)
  })

  it('编辑同样支持 n 扇出', async () => {
    const mock = installFetchMock(() => jsonResponse(imagePayload('https://cdn.test/e.png')))
    const response = await app.request('/v1/images/edits', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'agnes-image-2.5-flash', prompt: 'x', image: ['https://example.com/a.png'], n: 2 })
    })
    expect(response.status).toBe(200)
    expect(mock.calls).toHaveLength(2)
    expect((await response.json()).data).toHaveLength(2)
  })
})
