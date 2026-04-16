/**
 * 道具（物品）管理 + 图像生成
 */
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, badRequest, now } from '../utils/response.js'
import { generateImage } from '../services/image-generation.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

// GET /props?drama_id=1
app.get('/', async (c) => {
  const dramaId = Number(c.req.query('drama_id'))
  if (!dramaId) return badRequest(c, 'drama_id is required')
  const rows = db.select().from(schema.props)
    .where(eq(schema.props.dramaId, dramaId)).all()
  return success(c, rows)
})

// POST /props   { drama_id, name, type?, description?, prompt? }
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.drama_id || !body.name) return badRequest(c, 'drama_id and name are required')
  const ts = now()
  const res = db.insert(schema.props).values({
    dramaId: Number(body.drama_id),
    name: body.name,
    type: body.type || null,
    description: body.description || null,
    prompt: body.prompt || null,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const [row] = db.select().from(schema.props)
    .where(eq(schema.props.id, Number(res.lastInsertRowid))).all()
  return created(c, row)
})

// PUT /props/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }
  for (const key of ['name', 'type', 'description', 'prompt', 'imageUrl', 'localPath']) {
    const snakeKey = key.replace(/[A-Z]/g, m => '_' + m.toLowerCase())
    if (snakeKey in body) updates[key] = body[snakeKey]
    else if (key in body) updates[key] = body[key]
  }
  db.update(schema.props).set(updates).where(eq(schema.props.id, id)).run()
  return success(c)
})

// DELETE /props/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  db.delete(schema.props).where(eq(schema.props.id, id)).run()
  return success(c)
})

// POST /props/clear { drama_id } — 硬删该剧所有道具 + 清 storyboard_props 关联
app.post('/clear', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const dramaId = Number(body.drama_id)
  if (!dramaId) return badRequest(c, 'drama_id is required')

  const rows = db.select({ id: schema.props.id })
    .from(schema.props)
    .where(eq(schema.props.dramaId, dramaId)).all()
  const ids = rows.map(r => r.id)

  if (ids.length === 0) {
    logTaskSuccess('PropClear', 'noop', { dramaId })
    return success(c, { count: 0 })
  }

  for (const id of ids) {
    db.delete(schema.storyboardProps)
      .where(eq(schema.storyboardProps.propId, id)).run()
    db.delete(schema.props)
      .where(eq(schema.props.id, id)).run()
  }

  logTaskSuccess('PropClear', 'done', { dramaId, count: ids.length })
  return success(c, { count: ids.length })
})

// POST /props/:id/generate-image   { episode_id }
app.post('/:id/generate-image', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [prop] = db.select().from(schema.props).where(eq(schema.props.id, id)).all()
  if (!prop) return badRequest(c, 'Prop not found')
  if (!body.episode_id) return badRequest(c, 'episode_id is required')
  const [ep] = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, Number(body.episode_id))).all()
  if (!ep) return badRequest(c, 'Episode not found')

  // 优先用户自定义 prompt，否则按名字 + 描述拼
  const prompt = (prop.prompt && prop.prompt.trim())
    ? prop.prompt
    : `${prop.name}, ${prop.description || '道具立绘'}, 高质量, 正面, 白色背景, 电影感`
  try {
    logTaskStart('PropImage', 'generate', { propId: id, episodeId: ep.id, dramaId: prop.dramaId, customPrompt: !!prop.prompt })
    const genId = await generateImage({ propId: id, dramaId: prop.dramaId, prompt, configId: ep.imageConfigId ?? undefined })
    logTaskSuccess('PropImage', 'generate', { propId: id, generationId: genId })
    return success(c, { image_generation_id: genId })
  } catch (err: any) {
    logTaskError('PropImage', 'generate', { propId: id, error: err.message })
    return badRequest(c, err.message)
  }
})

export default app
