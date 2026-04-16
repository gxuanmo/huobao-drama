import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, badRequest, now } from '../utils/response.js'
import { generateImage } from '../services/image-generation.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

// POST /scenes
app.post('/', async (c) => {
  const body = await c.req.json()
  const ts = now()
  const res = db.insert(schema.scenes).values({
    dramaId: body.drama_id,
    episodeId: body.episode_id,
    location: body.location,
    time: body.time || '',
    prompt: body.prompt || body.location,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const [result] = db.select().from(schema.scenes)
    .where(eq(schema.scenes.id, Number(res.lastInsertRowid))).all()
  return created(c, result)
})

// PUT /scenes/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }
  if (body.location !== undefined) updates.location = body.location
  if (body.time !== undefined) updates.time = body.time
  if (body.prompt !== undefined) updates.prompt = body.prompt
  db.update(schema.scenes).set(updates).where(eq(schema.scenes.id, id)).run()
  return success(c)
})

// POST /scenes/:id/generate-image
app.post('/:id/generate-image', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [scene] = db.select().from(schema.scenes).where(eq(schema.scenes.id, id)).all()
  if (!scene) return badRequest(c, 'Scene not found')
  if (!body.episode_id) return badRequest(c, 'episode_id is required')
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id))).all()
  if (!ep) return badRequest(c, 'Episode not found')

  const prompt = scene.prompt || `${scene.location}, ${scene.time || ''}, 高质量场景, 电影感`
  try {
    logTaskStart('SceneImage', 'generate', { sceneId: id, episodeId: ep.id, dramaId: scene.dramaId, location: scene.location })
    db.update(schema.scenes).set({ status: 'processing', updatedAt: now() }).where(eq(schema.scenes.id, id)).run()
    const genId = await generateImage({ sceneId: id, dramaId: scene.dramaId, prompt, configId: ep.imageConfigId ?? undefined })
    logTaskSuccess('SceneImage', 'generate', { sceneId: id, generationId: genId })
    return success(c, { image_generation_id: genId })
  } catch (err: any) {
    logTaskError('SceneImage', 'generate', { sceneId: id, error: err.message })
    db.update(schema.scenes).set({ status: 'failed', updatedAt: now() }).where(eq(schema.scenes.id, id)).run()
    return badRequest(c, err.message)
  }
})

// DELETE /scenes/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  db.delete(schema.scenes).where(eq(schema.scenes.id, id)).run()
  return success(c)
})

// POST /scenes/clear { drama_id, episode_id? } — 硬删该剧/集所有场景 + 清 join 表
app.post('/clear', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const dramaId = Number(body.drama_id)
  const episodeId = body.episode_id ? Number(body.episode_id) : null
  if (!dramaId) return badRequest(c, 'drama_id is required')

  const allScenes = db.select({ id: schema.scenes.id, episodeId: schema.scenes.episodeId })
    .from(schema.scenes)
    .where(eq(schema.scenes.dramaId, dramaId)).all()
  const targetScenes = episodeId
    ? allScenes.filter(s => s.episodeId === episodeId)
    : allScenes
  const ids = targetScenes.map(s => s.id)

  if (ids.length === 0) {
    logTaskSuccess('SceneClear', 'noop', { dramaId, episodeId })
    return success(c, { count: 0 })
  }

  // 清 join 表
  for (const id of ids) {
    db.delete(schema.episodeScenes)
      .where(eq(schema.episodeScenes.sceneId, id)).run()
    db.delete(schema.scenes)
      .where(eq(schema.scenes.id, id)).run()
  }

  logTaskSuccess('SceneClear', 'done', { dramaId, episodeId, count: ids.length })
  return success(c, { count: ids.length })
})

export default app
