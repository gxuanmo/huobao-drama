/**
 * 分镜关联表（storyboard_characters / storyboard_props）同步工具
 * 被 routes/storyboards.ts 和 agents/tools/storyboard-tools.ts 共同使用
 */
import { eq } from 'drizzle-orm'
import { db, schema } from './index.js'

export function syncStoryboardCharacters(storyboardId: number, characterIds: number[]) {
  db.delete(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
    .run()
  const uniqueIds = [...new Set((characterIds || []).filter(Boolean))]
  if (!uniqueIds.length) return
  for (const characterId of uniqueIds) {
    db.insert(schema.storyboardCharacters).values({ storyboardId, characterId }).run()
  }
}

export function syncStoryboardProps(storyboardId: number, propIds: number[]) {
  db.delete(schema.storyboardProps)
    .where(eq(schema.storyboardProps.storyboardId, storyboardId))
    .run()
  const uniqueIds = [...new Set((propIds || []).filter(Boolean))]
  if (!uniqueIds.length) return
  for (const propId of uniqueIds) {
    db.insert(schema.storyboardProps).values({ storyboardId, propId }).run()
  }
}
