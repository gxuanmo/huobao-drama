/**
 * 阿里云百炼视频生成 Adapter
 *
 * 支持两类模型（同一端点、同一 key、同一轮询逻辑，仅请求体不同）：
 *
 * 1. 万相 wan 系列（wan2.7-i2v 等）
 *    input: { prompt, img_url, last_img_url }
 *    parameters: { resolution, duration, watermark, seed }
 *
 * 2. 可灵 Kling 系列（kling/kling-v3-omni-video-generation 等）
 *    input: { prompt, media: [{type, url}], element_list }
 *    parameters: { mode, aspect_ratio, duration, audio, watermark }
 *    media type: "first_frame" | "last_frame" | "refer" | "base"
 *
 * API: POST /api/v1/services/aigc/video-generation/video-synthesis
 * 轮询: GET /api/v1/tasks/{task_id}
 */
import type { VideoProviderAdapter, VideoGenerationRecord } from './types'
import { joinProviderUrl } from './url'

function isKlingModel(model: string): boolean {
  return model.startsWith('kling/')
}

export class AliVideoAdapter implements VideoProviderAdapter {
  readonly provider = 'ali'

  buildGenerateRequest(config: any, record: VideoGenerationRecord): {
    url: string
    method: string
    headers: Record<string, string>
    body: any
  } {
    const baseUrl = config.baseUrl || 'https://dashscope.aliyuncs.com'
    const url = joinProviderUrl(baseUrl, '/api/v1', '/services/aigc/video-generation/video-synthesis')
    const model = record.model || config.model || 'wan2.7-i2v'

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    }

    const body = isKlingModel(model)
      ? this.buildKlingBody(model, record)
      : this.buildWanBody(model, record)

    return { url, method: 'POST', headers, body }
  }

  private buildWanBody(model: string, record: VideoGenerationRecord): any {
    const body: any = {
      model,
      input: {
        prompt: record.prompt,
        img_url: record.imageUrl ?? record.firstFrameUrl ?? '',
      },
      parameters: {
        resolution: this.normalizeResolution(record.aspectRatio ?? '16:9'),
        duration: record.duration || 5,
        watermark: false,
        seed: Math.floor(Math.random() * 2147483647),
      },
    }
    if (record.lastFrameUrl) {
      body.input.last_img_url = record.lastFrameUrl
    }
    return body
  }

  private buildKlingBody(model: string, record: VideoGenerationRecord): any {
    const media: Array<{ type: string; url: string }> = []

    // 首帧
    const firstFrame = record.imageUrl ?? record.firstFrameUrl
    if (firstFrame) {
      media.push({ type: 'first_frame', url: firstFrame })
    }

    // 尾帧
    if (record.lastFrameUrl) {
      media.push({ type: 'last_frame', url: record.lastFrameUrl })
    }

    // 参考图（角色/场景/道具）→ type: "refer"
    if (record.referenceImageUrls) {
      try {
        const refs = JSON.parse(record.referenceImageUrls)
        for (const refUrl of refs) {
          if (refUrl) media.push({ type: 'refer', url: refUrl })
        }
      } catch {}
    }

    return {
      model,
      input: {
        prompt: record.prompt || '',
        media,
        element_list: [],
      },
      parameters: {
        mode: 'pro',
        aspect_ratio: record.aspectRatio || '16:9',
        duration: Math.min(15, Math.max(3, record.duration || 5)),
        audio: false,
        watermark: false,
      },
    }
  }

  parseGenerateResponse(result: any): {
    isAsync: boolean
    taskId?: string
    videoUrl?: string
  } {
    if (result.output?.task_status === 'PENDING' && result.output?.task_id) {
      return { isAsync: true, taskId: result.output.task_id }
    }
    if (result.output?.video_url) {
      return { isAsync: false, videoUrl: result.output.video_url }
    }
    throw new Error(`Unexpected Ali video response: ${JSON.stringify(result).slice(0, 200)}`)
  }

  buildPollRequest(config: any, taskId: string): {
    url: string
    method: string
    headers: Record<string, string>
    body: any
  } {
    const baseUrl = config.baseUrl || 'https://dashscope.aliyuncs.com'
    return {
      url: joinProviderUrl(baseUrl, '/api/v1', `/tasks/${taskId}`),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): {
    status: 'pending' | 'processing' | 'completed' | 'failed'
    videoUrl?: string
    error?: string
  } {
    const status = result.output?.task_status
    if (status === 'SUCCEEDED') {
      return { status: 'completed', videoUrl: result.output?.video_url }
    }
    if (status === 'FAILED') {
      return { status: 'failed', error: result.message || 'Video generation failed' }
    }
    if (status === 'PENDING' || status === 'RUNNING') {
      return { status: 'processing' }
    }
    return { status: 'pending' }
  }

  extractVideoUrl(result: any): string | null {
    return result.output?.video_url || null
  }

  private normalizeResolution(aspectRatio?: string): string {
    const ratio = aspectRatio || '16:9'
    if (ratio === '9:16') return '720P'
    if (ratio === '1:1') return '720P'
    return '1080P'
  }
}
