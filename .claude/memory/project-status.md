---
name: project-status
description: Key facts about huobao-drama project
metadata:
  type: project
---

Huobao Drama — AI 驱动的短剧/视频制作工具。全 TypeScript 栈。

**架构**：Hono + Drizzle ORM + Mastra（AI agents）+ better-sqlite3（后端）/ Vue 3 + Vite（前端）。

**2026-05-30 /checkup 发现**：
- 缺 settings.json（已补）、MEMORY.md（已补）
- 此前无任何自动化测试，已添加 backend vitest 冒烟测试
- backend 和 frontend 都没有 lint 脚本
- 无 CI/CD

**关键约束**：
- SQLite WAL 模式，数据库在 `data/drama_generator.db`
- Agent 定义在 `skills/` 目录（SKILL.md 格式），共 5 个 agent
- AI 配置在 `configs/config.yaml` 和 DB `ai_service_configs` 表
- SSE streaming 用于 agent chat 响应

**Why:** 项目轻量但功能完整，需要知道 Agent 配置的双来源（yaml + DB）。
**How to apply:** 改 AI agent 行为时，先查 `skills/` 下的 SKILL.md，再查 DB 里的 agent_configs。
