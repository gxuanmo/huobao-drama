/**
 * Local Gradio TTS Adapter
 *
 * 支持两个本地 Gradio Demo：
 *   - provider='qwen3-tts'  → Qwen3-TTS (/generate_custom_voice)
 *   - provider='index-tts'  → IndexTTS (/gen_single)
 *
 * Gradio 协议三步走：
 *   1. POST /gradio_api/call/{fn}   → 拿 event_id
 *   2. GET  /gradio_api/call/{fn}/{event_id}  (SSE) → 拿 FileData
 *   3. GET  {FileData.url}          → 下载音频二进制
 */
import type { TTSProviderAdapter, AIConfig, ProviderRequest } from './types'

const QWEN3_LANG_DEFAULT = 'Chinese'
const QWEN3_DEFAULT_SPEAKER = 'Dylan'
const QWEN3_DEFAULT_MODEL = '0.6B'

// IndexTTS emo_control_method 的第一个枚举值（使用音色参考音频作为情感来源）
// 原文: 与音色参考音频相同
const INDEX_EMO_METHOD_DEFAULT = '\u4e0e\u97f3\u8272\u53c2\u8003\u97f3\u9891\u76f8\u540c'

interface GradioFileData {
  path: string
  url: string
}

async function gradioCall(base: string, fnName: string, data: any[]): Promise<GradioFileData> {
  const startResp = await fetch(`${base}/gradio_api/call/${fnName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  })
  if (!startResp.ok) {
    const txt = await startResp.text().catch(() => '')
    throw new Error(`Gradio call(${fnName}) start ${startResp.status}: ${txt.slice(0, 300)}`)
  }
  const startJson = await startResp.json() as { event_id?: string }
  if (!startJson.event_id) {
    throw new Error(`Gradio call(${fnName}) missing event_id: ${JSON.stringify(startJson).slice(0, 200)}`)
  }

  const streamResp = await fetch(`${base}/gradio_api/call/${fnName}/${startJson.event_id}`)
  if (!streamResp.ok) {
    throw new Error(`Gradio stream(${fnName}) ${streamResp.status}`)
  }
  const sseText = await streamResp.text()

  // 解析 SSE: 寻找 "event: complete\ndata: <json>" 或 "event: error\ndata: <msg>"
  const lines = sseText.split(/\r?\n/)
  let completePayload: any = null
  let errorMsg: string | null = null
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]
    const next = lines[i + 1]
    if (line === 'event: complete' && next.startsWith('data: ')) {
      try { completePayload = JSON.parse(next.slice(6)) } catch {}
    } else if (line === 'event: error' && next.startsWith('data: ')) {
      errorMsg = next.slice(6)
    }
  }
  if (errorMsg) throw new Error(`Gradio ${fnName} error: ${errorMsg}`)
  if (completePayload == null) {
    throw new Error(`Gradio ${fnName} stream ended without complete event: ${sseText.slice(0, 500)}`)
  }

  // Gradio 返回有两种形态：
  //   Qwen3:    [FileData, optionalMsg]                            → first = FileData
  //   IndexTTS: [{visible, value: FileData, __type__: 'update'}]  → first.value = FileData
  const first = Array.isArray(completePayload) ? completePayload[0] : completePayload
  if (!first || typeof first !== 'object') {
    throw new Error(`Gradio ${fnName} unexpected result: ${JSON.stringify(first).slice(0, 200)}`)
  }
  const fileData: any = (first as any).__type__ === 'update' && (first as any).value
    ? (first as any).value
    : first
  if (!fileData || (!fileData.url && !fileData.path)) {
    throw new Error(`Gradio ${fnName} result missing file info: ${JSON.stringify(first).slice(0, 200)}`)
  }
  return { path: fileData.path || '', url: fileData.url || '' }
}

/**
 * 把本地 Buffer 上传到 Gradio /gradio_api/upload，返回服务端本地路径
 */
async function gradioUpload(base: string, buffer: Buffer, filename: string): Promise<string> {
  const form = new FormData()
  const blob = new Blob([new Uint8Array(buffer)], { type: 'audio/wav' })
  form.append('files', blob, filename)
  const resp = await fetch(`${base}/gradio_api/upload`, { method: 'POST', body: form })
  if (!resp.ok) {
    throw new Error(`Gradio upload ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
  }
  const arr = await resp.json() as string[]
  if (!Array.isArray(arr) || !arr[0]) {
    throw new Error(`Gradio upload unexpected response: ${JSON.stringify(arr).slice(0, 200)}`)
  }
  return arr[0]
}

/**
 * 从 http(s) URL 或本地相对路径拿到音频 Buffer
 * 支持 huobao-drama 存的 'static/audio/xxx.wav' 相对路径
 */
async function fetchAudioBuffer(voice: string): Promise<{ buffer: Buffer; filename: string }> {
  if (/^https?:\/\//i.test(voice)) {
    const resp = await fetch(voice)
    if (!resp.ok) throw new Error(`fetch ref audio ${resp.status}: ${voice}`)
    const buffer = Buffer.from(await resp.arrayBuffer())
    const filename = voice.split('/').pop() || 'ref.wav'
    return { buffer, filename }
  }
  // 否则当成本地 path（huobao storage），暂不支持
  throw new Error(`IndexTTS voice must be an http(s) URL to a reference audio (got "${voice}")`)
}

async function downloadAudio(base: string, file: GradioFileData): Promise<Buffer> {
  let url = file.url
  if (!url) {
    url = `${base}/gradio_api/file=${file.path}`
  }
  const resp = await fetch(url)
  if (!resp.ok) {
    throw new Error(`Gradio file download ${resp.status}: ${url}`)
  }
  return Buffer.from(await resp.arrayBuffer())
}

export class LocalGradioTTSAdapter implements TTSProviderAdapter {
  readonly provider = 'local-gradio'

  // 传统路径不用，留空即可
  buildGenerateRequest(_config: AIConfig, _params: any): ProviderRequest {
    return { url: '', method: 'POST', headers: {}, body: null }
  }
  parseResponse(_result: any) {
    return { audioHex: '', audioLength: 0, sampleRate: 0, bitrate: 0, format: 'wav', channel: 1 }
  }

  async generateAudio(config: AIConfig, params: any): Promise<{
    buffer: Buffer
    format: string
    sampleRate?: number
    audioLength?: number
  }> {
    const provider = (config.provider || '').toLowerCase()
    const base = (config.baseUrl || '').replace(/\/+$/, '')
    if (!base) throw new Error('LocalGradioTTS: base_url is empty')

    const text: string = params.text
    const voice: string = params.voice || ''

    if (provider === 'qwen3-tts' || provider === 'qwen3') {
      const model = config.model && /^1\.7B$/i.test(config.model) ? '1.7B' : QWEN3_DEFAULT_MODEL
      const speaker = voice || QWEN3_DEFAULT_SPEAKER
      const instruct: string = params.emotion || params.instruct || ''
      const data = [text, QWEN3_LANG_DEFAULT, speaker, instruct, model]
      const file = await gradioCall(base, 'generate_custom_voice', data)
      const buffer = await downloadAudio(base, file)
      return { buffer, format: 'wav', sampleRate: 24000 }
    }

    if (provider === 'index-tts' || provider === 'indextts') {
      // IndexTTS 需要参考音频。约定：huobao voice_id 填参考音频的 http(s):// URL
      // 流程：下载参考音频 → 上传到 Gradio → 用返回的服务端本地路径作为 prompt
      const { buffer: refBuf, filename: refName } = await fetchAudioBuffer(voice)
      const uploadedPath = await gradioUpload(base, refBuf, refName)
      const refAudio = { path: uploadedPath, meta: { _type: 'gradio.FileData' } }
      const data = [
        INDEX_EMO_METHOD_DEFAULT, // emo_control_method
        refAudio,                 // prompt (reference audio)
        text,                     // text
        null,                     // emo_ref_path
        0.65,                     // emo_weight
        0, 0, 0, 0, 0, 0, 0, 0,   // vec1..vec8
        params.emo_text || '',    // emo_text
        false,                    // emo_random
        120,                      // max_text_tokens_per_segment
        true,                     // param_16 (do_sample)
        0.8,                      // param_17 (top_p)
        30,                       // param_18 (top_k)
        0.8,                      // param_19 (temperature)
        0,                        // param_20 (length_penalty)
        3,                        // param_21 (num_beams)
        10,                       // param_22 (repetition_penalty)
        1500,                     // param_23 (max_mel_tokens)
      ]
      const file = await gradioCall(base, 'gen_single', data)
      const buffer = await downloadAudio(base, file)
      return { buffer, format: 'wav', sampleRate: 22050 }
    }

    throw new Error(`LocalGradioTTSAdapter: unknown provider "${config.provider}"`)
  }
}
