/**
 * 文件存储工具 — 下载远程文件到本地
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'
import { v4 as uuid } from 'uuid'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(__dirname, '../../../data/static')
const DATA_ROOT = path.resolve(STORAGE_ROOT, '..')

// 远程下载体积/超时上限：避免单个文件吃光磁盘或永久卡住
const DOWNLOAD_MAX_BYTES = Number(process.env.DOWNLOAD_MAX_BYTES) || 200 * 1024 * 1024 // 200 MB
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS) || 120_000

// 上传白名单 — 限制扩展名以避免 SVG/HTML 等被静态托管路径直接命中浏览器后触发 XSS
const ALLOWED_UPLOAD_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
  '.mp4', '.mov', '.webm',
  '.mp3', '.wav', '.m4a', '.ogg',
])

function safeExt(name: string): string {
  const raw = path.extname(name || '').toLowerCase()
  // 防止路径分隔符/空字节被注入到文件名
  if (!raw || raw.length > 6 || /[\/\\\0]/.test(raw)) return ''
  return raw
}

/**
 * 下载远程文件到本地存储
 *
 * 增加：超时 + 体积上限 + 流式写入，避免远端卡死或撑爆内存/磁盘
 */
export async function downloadFile(url: string, subDir: string): Promise<string> {
  const dir = path.join(STORAGE_ROOT, subDir)
  fs.mkdirSync(dir, { recursive: true })

  const ext = getExtFromUrl(url)
  const filename = `${uuid()}${ext}`
  const filePath = path.join(dir, filename)

  const resp = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`)

  // Content-Length 提前拦截过大文件
  const declaredLen = Number(resp.headers.get('content-length') || 0)
  if (declaredLen && declaredLen > DOWNLOAD_MAX_BYTES) {
    throw new Error(`Download too large: ${declaredLen} bytes (max ${DOWNLOAD_MAX_BYTES})`)
  }

  // 流式落盘 + 实时校验体积
  const body = resp.body
  if (!body) throw new Error('Download has no body')
  const fileHandle = await fs.promises.open(filePath, 'w')
  let received = 0
  try {
    const reader = (body as ReadableStream<Uint8Array>).getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      received += value.byteLength
      if (received > DOWNLOAD_MAX_BYTES) {
        try { await reader.cancel() } catch {}
        throw new Error(`Download exceeded max size ${DOWNLOAD_MAX_BYTES}`)
      }
      await fileHandle.write(value)
    }
  } catch (err) {
    await fileHandle.close().catch(() => {})
    fs.promises.unlink(filePath).catch(() => {})
    throw err
  }
  await fileHandle.close()

  // 返回相对路径（供 API 返回给前端）
  return `static/${subDir}/${filename}`
}

/**
 * 保存上传的文件
 *
 * @param maxBytes 单文件大小上限。超出抛错。
 * @param allowedExts 可选扩展名白名单，命中才允许保存（小写，含 `.`）。
 */
export async function saveUploadedFile(
  data: ArrayBuffer,
  subDir: string,
  originalName: string,
  options: { maxBytes?: number; allowedExts?: Set<string> } = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024 // 50 MB 默认上限
  if (data.byteLength > maxBytes) {
    throw new Error(`File too large: ${data.byteLength} bytes (max ${maxBytes})`)
  }

  const ext = safeExt(originalName)
  const allowed = options.allowedExts ?? ALLOWED_UPLOAD_EXTS
  if (!ext || !allowed.has(ext)) {
    throw new Error(`Unsupported file type: "${path.extname(originalName) || 'unknown'}"`)
  }

  const dir = path.join(STORAGE_ROOT, subDir)
  fs.mkdirSync(dir, { recursive: true })
  const filename = `${uuid()}${ext}`
  const filePath = path.join(dir, filename)

  await fs.promises.writeFile(filePath, Buffer.from(data))
  return `static/${subDir}/${filename}`
}

function getExtFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname
    const ext = path.extname(pathname)
    if (ext && ext.length <= 5) return ext
  } catch {}
  return '.bin'
}

/**
 * 获取本地文件的绝对路径
 *
 * 解析后必须落在 DATA_ROOT 下，防止 `..` 路径穿越读取任意文件。
 */
export function getAbsolutePath(relativePath: string): string {
  const cleaned = String(relativePath || '').replace(/\0/g, '')
  const baseRoot = cleaned.startsWith('static/') ? DATA_ROOT : STORAGE_ROOT
  const resolved = path.resolve(baseRoot, cleaned)
  const safeRoot = path.resolve(DATA_ROOT)
  // 必须在数据根目录下
  if (resolved !== safeRoot && !resolved.startsWith(safeRoot + path.sep)) {
    throw new Error(`Path outside storage root: ${relativePath}`)
  }
  return resolved
}

/**
 * 保存 Base64 编码的图片数据到本地存储
 * 用于 Gemini 等只返回 base64 数据的厂商
 */
export async function saveBase64Image(base64Data: string, mimeType: string, subDir: string): Promise<string> {
  if (!base64Data) throw new Error('Empty base64 image data')
  const dir = path.join(STORAGE_ROOT, subDir)
  fs.mkdirSync(dir, { recursive: true })

  // 从 mimeType 推断文件扩展名
  const ext = mimeTypeToExt(mimeType)
  const filename = `${uuid()}${ext}`
  const filePath = path.join(dir, filename)

  const buffer = Buffer.from(base64Data, 'base64')
  await fs.promises.writeFile(filePath, buffer)

  return `static/${subDir}/${filename}`
}

export function readImageAsDataUrl(relativePath: string): string {
  const filePath = getAbsolutePath(relativePath)
  const buffer = fs.readFileSync(filePath)
  const ext = path.extname(filePath).toLowerCase()
  const mimeType = extToMimeType(ext)
  return `data:${mimeType};base64,${buffer.toString('base64')}`
}

export async function readImageAsCompressedDataUrl(
  relativePath: string,
  options: {
    maxWidth?: number
    maxHeight?: number
    quality?: number
  } = {},
): Promise<string> {
  const filePath = getAbsolutePath(relativePath)
  const maxWidth = options.maxWidth ?? 768
  const maxHeight = options.maxHeight ?? 768
  const quality = options.quality ?? 68

  const resized = sharp(filePath).rotate().resize({
    width: maxWidth,
    height: maxHeight,
    fit: 'inside',
    withoutEnlargement: true,
  })
  const metadata = await resized.metadata()
  const output = metadata.hasAlpha
    ? await resized.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toBuffer()
    : await resized.jpeg({ quality, mozjpeg: true }).toBuffer()
  const mimeType = 'image/jpeg'
  return `data:${mimeType};base64,${output.toString('base64')}`
}

export function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  return {
    mimeType: match[1],
    data: match[2],
  }
}

function mimeTypeToExt(mimeType: string): string {
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
  }
  return map[mimeType] || '.png'
}

function extToMimeType(ext: string): string {
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  }
  return map[ext] || 'image/png'
}
