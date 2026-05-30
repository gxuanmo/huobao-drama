import { Hono } from 'hono'
import { success, badRequest } from '../utils/response.js'
import { saveUploadedFile } from '../utils/storage.js'

const app = new Hono()

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const IMAGE_MAX_BYTES = Number(process.env.UPLOAD_IMAGE_MAX_BYTES) || 20 * 1024 * 1024 // 20 MB

// POST /upload/image
app.post('/image', async (c) => {
  let body: Record<string, any>
  try {
    body = await c.req.parseBody()
  } catch (err: any) {
    return badRequest(c, `Invalid form: ${err.message || err}`)
  }
  const file = body['file']

  if (!file || !(file instanceof File)) {
    return badRequest(c, 'file is required')
  }

  // 简单 mime 校验：必须是图片，避免上传 SVG/HTML 经静态托管路径执行 XSS
  if (file.type && !file.type.startsWith('image/')) {
    return badRequest(c, `Unsupported mime type: ${file.type}`)
  }
  if (file.type === 'image/svg+xml') {
    return badRequest(c, 'SVG uploads are not allowed')
  }
  if (file.size > IMAGE_MAX_BYTES) {
    return badRequest(c, `File too large: ${file.size} bytes (max ${IMAGE_MAX_BYTES})`)
  }

  try {
    const buffer = await file.arrayBuffer()
    const path = await saveUploadedFile(buffer, 'uploads', file.name, {
      maxBytes: IMAGE_MAX_BYTES,
      allowedExts: IMAGE_EXTS,
    })
    return success(c, { url: `/${path}`, path })
  } catch (err: any) {
    return badRequest(c, err.message || 'Upload failed')
  }
})

export default app
