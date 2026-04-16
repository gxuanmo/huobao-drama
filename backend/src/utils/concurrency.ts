/**
 * 简单 semaphore，用来限制每类 AI 生成服务的全局并发。
 *
 * 背景：阿里云百炼对每个 model 都有 RPM（分钟请求数）限制，默认个人账号大概
 * 60 RPM。如果前端一次触发 20 个图片生成，全部并行打上去会立刻撞 429
 * (Throttling.RateQuota)。这里把每类服务的 in-flight 请求数上限锁死，
 * 后来的任务排队等前面的释放。
 *
 * 只对「向上游发起请求 + 拿到 task_id 的那一瞬间」加锁，不覆盖整个轮询阶段
 * ——因为 Ali 的限流是针对请求速率，polling 是独立的 GET 任务端点，
 * 数量很大但通常不受同一个 RPM 池的影响。
 */

export class Semaphore {
  private active = 0
  private queue: Array<() => void> = []

  constructor(public readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++
      return () => this.release()
    }
    await new Promise<void>(resolve => {
      this.queue.push(() => {
        this.active++
        resolve()
      })
    })
    return () => this.release()
  }

  /** 包装一个 async 函数，自动 acquire/release。 */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }

  get stats() {
    return { active: this.active, queued: this.queue.length, limit: this.limit }
  }

  private release() {
    this.active--
    const next = this.queue.shift()
    if (next) next()
  }
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key]
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/**
 * 每类服务的并发上限。通过环境变量可调：
 *   IMAGE_CONCURRENCY  默认 2
 *   VIDEO_CONCURRENCY  默认 1
 *   TTS_CONCURRENCY    默认 2
 *
 * 调小这些值越安全（越不容易撞 429），但同时等待时间变长。
 */
export const aiSemaphores = {
  image: new Semaphore(envInt('IMAGE_CONCURRENCY', 2)),
  video: new Semaphore(envInt('VIDEO_CONCURRENCY', 1)),
  tts: new Semaphore(envInt('TTS_CONCURRENCY', 2)),
}
