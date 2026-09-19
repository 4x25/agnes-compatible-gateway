import { beforeAll, describe, expect, it } from 'vitest'
import { liveContext, readJson, recordResult, type LiveContext } from '../helpers/live.js'
import { withTransientRetry } from '../helpers/env.js'

let live: LiveContext

beforeAll(() => {
  live = liveContext()
})

function post(path: string, body: unknown): Promise<Response> {
  return live.app.request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${live.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

async function generate(body: unknown): Promise<{ status: number; body: any }> {
  return withTransientRetry(async () => {
    const response = await post('/v1/images/generations', body)
    const parsed = await readJson(response)
    if (response.status === 401) throw new Error('transient 401')
    return { status: response.status, body: parsed }
  })
}

describe.skipIf(!liveContext().enabled)('真实上游 · 图像', () => {
  it('缺省 size 生成图片返回 URL', async () => {
    const result = await generate({
      model: 'agnes-image-2.5-flash',
      prompt: 'A minimal flat illustration of a red apple on a white background, product photo'
    })
    recordResult('live-images.jsonl', { case: 'images.default_size', status: result.status, body: result.body })
    expect(result.status).toBe(200)
    expect(Object.keys(result.body).sort()).toEqual(['created', 'data'])
    expect(result.body.data).toHaveLength(1)
    expect(result.body.data[0].url).toMatch(/^https?:\/\//)
    expect(result.body.data[0].b64_json).toBeNull()
  }, 300_000)

  it('b64_json 输出返回 base64 数据', async () => {
    const result = await generate({
      model: 'agnes-image-2.5-flash',
      prompt: 'A blue circle centered on a white background, flat design',
      size: '1024x1024',
      response_format: 'b64_json'
    })
    recordResult('live-images.jsonl', {
      case: 'images.b64_json',
      status: result.status,
      dataLength: result.body?.data?.[0]?.b64_json?.length,
      url: result.body?.data?.[0]?.url
    })
    expect(result.status).toBe(200)
    expect(typeof result.body.data[0].b64_json).toBe('string')
    expect(result.body.data[0].b64_json.length).toBeGreaterThan(1000)
  }, 300_000)

  it('n=2 扇出返回两张图', async () => {
    const result = await generate({
      model: 'agnes-image-2.5-flash',
      prompt: 'A small green triangle on a white background, flat design',
      size: '1K'
    })
    expect(result.status).toBe(200)

    const started = Date.now()
    const two = await generate({
      model: 'agnes-image-2.5-flash',
      prompt: 'A small green triangle on a white background, flat design variant',
      size: '1K',
      n: 2
    })
    recordResult('live-images.jsonl', {
      case: 'images.n2',
      status: two.status,
      urls: two.body?.data?.map((item: any) => item.url),
      elapsed_ms: Date.now() - started
    })
    expect(two.status).toBe(200)
    expect(two.body.data).toHaveLength(2)
    expect(new Set(two.body.data.map((item: any) => item.url)).size).toBe(2)
  }, 600_000)

  it('图生图：以生成的图片作为输入做编辑', async () => {
    const base = await generate({
      model: 'agnes-image-2.5-flash',
      prompt: 'A plain white ceramic mug on a wooden table, product photo, soft light'
    })
    expect(base.status).toBe(200)
    const sourceUrl: string = base.body.data[0].url

    const edited = await generate({
      model: 'agnes-image-2.5-flash',
      prompt: 'Change the mug color to matte black while preserving the original composition',
      size: '1024x1024',
      image: [sourceUrl]
    })
    recordResult('live-images.jsonl', { case: 'images.img2img', status: edited.status, source: sourceUrl, body: edited.body })
    expect(edited.status).toBe(200)
    expect(edited.body.data[0].url).toMatch(/^https?:\/\//)
  }, 600_000)

  it('多图合成：两张输入图', async () => {
    const first = await generate({ model: 'agnes-image-2.5-flash', prompt: 'A flat vector illustration of a golden crown on white background' })
    const second = await generate({ model: 'agnes-image-2.5-flash', prompt: 'A flat vector illustration of a red rose on white background' })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)

    const composed = await generate({
      model: 'agnes-image-2.5-flash',
      prompt: 'Combine the crown and the rose into one elegant emblem, clean composition, flat vector style',
      size: '1024x1024',
      image: [first.body.data[0].url, second.body.data[0].url]
    })
    recordResult('live-images.jsonl', { case: 'images.multi_image', status: composed.status, body: composed.body })
    expect(composed.status).toBe(200)
    expect(composed.body.data[0].url).toMatch(/^https?:\/\//)
  }, 600_000)

  it('/v1/images/edits multipart 上传真实图片可编辑', async () => {
    const base = await generate({ model: 'agnes-image-2.5-flash', prompt: 'A simple red square on a white background, flat design' })
    expect(base.status).toBe(200)

    const downloaded = await fetch(base.body.data[0].url)
    const bytes = new Uint8Array(await downloaded.arrayBuffer())

    const form = new FormData()
    form.set('model', 'agnes-image-2.5-flash')
    form.set('prompt', 'Make the square blue while preserving the layout and composition')
    form.set('size', '1024x1024')
    form.append('image', new File([bytes], 'input.png', { type: 'image/png' }))

    const response = await withTransientRetry(async () => {
      const result = await live.app.request('/v1/images/edits', {
        method: 'POST',
        headers: { authorization: `Bearer ${live.apiKey}` },
        body: form
      })
      if (result.status === 401) throw new Error('transient 401')
      return result
    })
    const body = await readJson(response)
    recordResult('live-images.jsonl', { case: 'images.edits_multipart', status: response.status, body })
    expect(response.status).toBe(200)
    expect(body.data[0].url).toMatch(/^https?:\/\//)
  }, 600_000)

  it('无效尺寸返回 400', async () => {
    const response = await post('/v1/images/generations', { model: 'agnes-image-2.5-flash', prompt: 'x', size: '99999x1' })
    expect(response.status).toBe(200)
    const body = await readJson(response)
    expect(body.data).toHaveLength(1)
  }, 300_000)

  it('未适配图像模型透传', async () => {
    const result = await generate({ model: 'agnes-image-2.1-flash', prompt: 'A small yellow star on white background', size: '1024x1024' })
    recordResult('live-images.jsonl', { case: 'images.passthrough', status: result.status, body: result.body })
    expect(result.status).toBe(200)
  }, 300_000)
})
