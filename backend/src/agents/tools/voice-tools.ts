/**
 * 角色音色分配 Agent 工具
 */
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { db, schema } from '../../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../../utils/response.js'
import { logTaskProgress, logTaskSuccess } from '../../utils/task-logger.js'

export function createVoiceTools(episodeId: number, dramaId: number) {
  function getEpisodeAudioProvider() {
    const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
    if (!episode?.audioConfigId) return null
    const [config] = db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, episode.audioConfigId)).all()
    return config?.provider || null
  }

  const getCharacters = createTool({
    id: 'get_characters',
    description: 'Get all characters for the current drama with their current voice assignments.',
    inputSchema: z.object({}),
    execute: async () => {
      const chars = db.select().from(schema.characters)
        .where(eq(schema.characters.dramaId, dramaId)).all()
      const payload = {
        characters: chars.map(c => ({
          id: c.id,
          name: c.name,
          role: c.role,
          personality: c.personality,
          description: c.description,
          current_voice: c.voiceStyle || '未分配',
        })),
      }
      logTaskSuccess('VoiceTool', 'get-characters', { episodeId, dramaId, count: payload.characters.length })
      return payload
    },
  })

  const listVoices = createTool({
    id: 'list_voices',
    description: 'List all available voice options for TTS.',
    inputSchema: z.object({}),
    execute: async () => {
      const provider = getEpisodeAudioProvider() || 'minimax'
      const rows = db.select().from(schema.aiVoices).where(eq(schema.aiVoices.provider, provider)).all()
      const voices = rows.length ? rows.map(v => {
        const desc = v.description ? JSON.parse(v.description) : []
        return {
          id: v.voiceId,
          name: v.voiceName,
          gender: inferGender(v.voiceName, desc),
          traits: Array.isArray(desc) && desc.length ? desc.slice(0, 2).join('、') : `${v.language || '多语言'}音色`,
          suitable_for: Array.isArray(desc) && desc.length > 2 ? desc.slice(2).join('、') : `${v.language || '通用'}角色`,
          language: v.language,
          provider,
        }
      }) : getFallbackVoices(provider)

      const payload = {
        provider,
        voices,
        instruction: '根据角色的性别、性格、年龄来匹配最合适的音色，并且只能从当前集音频配置可用的音色列表中选择。',
      }
      logTaskSuccess('VoiceTool', 'list-voices', { episodeId, provider, count: payload.voices.length })
      return payload
    },
  })

  const assignVoice = createTool({
    id: 'assign_voice',
    description: 'Assign a voice to a character.',
    inputSchema: z.object({
      character_id: z.number().describe('Character ID'),
      voice_id: z.string().describe('Voice ID from list_voices'),
      reason: z.string().optional().describe('Why this voice fits'),
    }),
    execute: async ({ character_id, voice_id, reason }) => {
      const provider = getEpisodeAudioProvider() || 'minimax'
      logTaskProgress('VoiceTool', 'assign-begin', { episodeId, dramaId, characterId: character_id, voiceId: voice_id, provider, reason })
      db.update(schema.characters)
        .set({ voiceStyle: voice_id, voiceProvider: provider, voiceSampleUrl: null, updatedAt: now() })
        .where(eq(schema.characters.id, character_id))
        .run()
      logTaskSuccess('VoiceTool', 'assign-complete', { episodeId, characterId: character_id, voiceId: voice_id, provider })
      return { message: `Assigned voice "${voice_id}" to character ${character_id}`, reason }
    },
  })

  return { getCharacters, listVoices, assignVoice }
}

function inferGender(name: string, desc: unknown) {
  const description = Array.isArray(desc) ? desc.join(' ') : ''
  const text = `${name} ${description}`
  if (/[男|青年|大爷|学长|boy|man|male]/i.test(text)) return '男声'
  if (/[女|少女|御姐|奶奶|girl|woman|female]/i.test(text)) return '女声'
  return '中性'
}

/**
 * Provider 专属的 fallback 音色列表。
 * 当 ai_voices 表里没有对应 provider 的数据时，用这里的硬编码值代替，
 * 避免 agent 拿到其它厂商的 voice_id 导致 TTS 调用全部失败。
 */
function getFallbackVoices(provider: string) {
  const p = (provider || '').toLowerCase()

  // Qwen3-TTS 9 个预设 speaker，语言默认中文
  if (p === 'qwen3-tts' || p === 'qwen3') {
    return [
      { id: 'Dylan',    name: 'Dylan',    gender: '男声', traits: '年轻有力',     suitable_for: '男主、青年男性', language: '多语言', provider },
      { id: 'Aiden',    name: 'Aiden',    gender: '男声', traits: '温暖沉稳',     suitable_for: '成熟男性、暖男', language: '多语言', provider },
      { id: 'Eric',     name: 'Eric',     gender: '男声', traits: '清朗明快',     suitable_for: '正派角色、学生', language: '多语言', provider },
      { id: 'Ryan',     name: 'Ryan',     gender: '男声', traits: '磁性低沉',     suitable_for: '反派、酷哥',     language: '多语言', provider },
      { id: 'Uncle_fu', name: 'Uncle Fu', gender: '男声', traits: '年长厚重',     suitable_for: '长辈、旁白、系统', language: '多语言', provider },
      { id: 'Serena',   name: 'Serena',   gender: '女声', traits: '清冷优雅',     suitable_for: '高冷校花、大小姐', language: '多语言', provider },
      { id: 'Vivian',   name: 'Vivian',   gender: '女声', traits: '成熟妩媚',     suitable_for: '御姐、少妇',     language: '多语言', provider },
      { id: 'Sohee',    name: 'Sohee',    gender: '女声', traits: '甜美纯欲',     suitable_for: '萝莉、纯欲女主', language: '多语言', provider },
      { id: 'Ono_anna', name: 'Ono Anna', gender: '女声', traits: '俏皮灵动',     suitable_for: '活泼少女、配角', language: '多语言', provider },
    ]
  }

  // IndexTTS 用的是"参考音频克隆"模式，voice_id 必须是参考音频 URL，
  // 没法预设音色列表。让 agent 知道这个约束。
  if (p === 'index-tts' || p === 'indextts') {
    return [
      {
        id: 'REQUIRES_REFERENCE_AUDIO_URL',
        name: 'IndexTTS 需参考音频',
        gender: '中性',
        traits: '零样本克隆',
        suitable_for: 'voice_id 必须是 http(s):// 参考音频 URL。本条仅作占位，请手动为角色指定参考音频。',
        language: '多语言',
        provider,
      },
    ]
  }

  // 其它 provider（OpenAI/chatfire 等）保持旧的 OpenAI 6 音色
  return [
    { id: 'alloy',   name: 'Alloy',   gender: '中性', traits: '平衡自然',     suitable_for: '旁白、通用',       language: '多语言', provider },
    { id: 'echo',    name: 'Echo',    gender: '男声', traits: '低沉稳重',     suitable_for: '成熟男性、旁白',   language: '多语言', provider },
    { id: 'fable',   name: 'Fable',   gender: '男声', traits: '温暖富有表现力', suitable_for: '年轻男性、故事叙述', language: '多语言', provider },
    { id: 'onyx',    name: 'Onyx',    gender: '男声', traits: '深沉有力',     suitable_for: '权威角色、反派',   language: '多语言', provider },
    { id: 'nova',    name: 'Nova',    gender: '女声', traits: '温柔甜美',     suitable_for: '年轻女性、女主',   language: '多语言', provider },
    { id: 'shimmer', name: 'Shimmer', gender: '女声', traits: '明亮活泼',     suitable_for: '活泼女性、少女',   language: '多语言', provider },
  ]
}
