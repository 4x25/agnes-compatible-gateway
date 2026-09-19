import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGNES_BASE_URL, deriveQueryUrl, resolveUpstreamConfig } from '../../src/lib/config.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('上游地址解析', () => {
  it('缺省使用官方 base', () => {
    // vitest 配置里为单测预置了 AGNES_BASE_URL，这里置空以验证真正的缺省分支
    vi.stubEnv('AGNES_BASE_URL', '')
    const config = resolveUpstreamConfig({})
    expect(config.baseUrl).toBe(DEFAULT_AGNES_BASE_URL)
    expect(config.queryUrl).toBe('https://apihub.agnes-ai.com/agnesapi')
  })

  it('去掉 base 末尾斜杠，并由 base 推导视频查询地址', () => {
    const config = resolveUpstreamConfig({ AGNES_BASE_URL: 'https://example.test/proxy/agnes/v1/' })
    expect(config.baseUrl).toBe('https://example.test/proxy/agnes/v1')
    // 视频查询走 <origin><prefix>/agnesapi，即去掉尾部 /v1
    expect(config.queryUrl).toBe('https://example.test/proxy/agnes/agnesapi')
  })

  it('base 不含 /v1 时同样拼接 /agnesapi', () => {
    expect(deriveQueryUrl('https://example.test/proxy/agnes')).toBe('https://example.test/proxy/agnes/agnesapi')
  })

  it('空白取值回落到缺省 base', () => {
    vi.stubEnv('AGNES_BASE_URL', '')
    expect(resolveUpstreamConfig({ AGNES_BASE_URL: '   ' }).baseUrl).toBe(DEFAULT_AGNES_BASE_URL)
  })
})
