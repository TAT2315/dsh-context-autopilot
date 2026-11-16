/**
 * context-autopilot — 会话上下文超过阈值时自动压缩。
 *
 * 触发点：`turn/end`（轮次已提交，驱动器即将空闲）+ 每轮记录的最新 usage。
 * 动作：`agent.runMaintenance()` 里调 `ctx.compaction.compactNow()`，
 *       即与人工 `/compact` 完全相同的路径，只是不需要人按。
 *
 * 为什么需要它：内置 `dsh-compaction-basic` 的自动阈值是
 *   floor(min(W×0.8, W − O − headroomTokens))，典型 W=1048576、O=256000、
 *   headroom=65536，算出 727,040 —— 而实测退化从 ~40 万开始、55 万以上高发，
 *   内置阈值永远来不及。
 */

import { contextTokensOf, readConfig } from './lib.js'

export const name = 'context-autopilot'

/** 等驱动器真正让出 agent 之后再接管维护窗口。 */
const CLAIM_DELAY_MS = 50

/** 失败时只记录，不打断会话。 */
function warn(ctx, message, detail) {
  try {
    const logger = (ctx && ctx.logger) || console
    if (typeof logger.warn === 'function') {
      logger.warn('[context-autopilot] ' + message, detail)
    }
  } catch {
    /* 日志失败不影响主流程 */
  }
}

export function apply(ctx, config) {
  const options = readConfig(config)
  const sessions = new Map()
  let compaction

  /**
   * 恢复会话时补一次基线：从已提交的历史里找最后一条 assistant/message 的 usage。
   * 不做这一步，长会话恢复后的第一轮会先撞上超大请求，压缩只能在事后发生。
   */
  const seedTokens = (agent) => {
    try {
      const events = typeof agent.session.ownEvents === 'function' ? agent.session.ownEvents() : []
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (event && event.type === 'assistant/message') {
          const tokens = contextTokensOf(event.data && event.data.usage)
          if (tokens >= 0) return tokens
        }
      }
    } catch {
      /* 读历史失败就退化为“等下一轮再测” */
    }
    return -1
  }

  const track = (agent) => {
    if (!agent || !agent.session) return undefined
    const id = agent.session.id
    let state = sessions.get(id)
    if (!state) {
      state = { agent, tokens: seedTokens(agent), busy: false, lastAttempt: 0 }
      sessions.set(id, state)
    } else {
      state.agent = agent
    }
    return state
  }

  const schedule = (state, triggerTokens) => {
    if (!compaction || state.busy) return
    if (state.tokens < options.thresholdTokens) return
    if (Date.now() - state.lastAttempt < options.cooldownMs) return

    state.busy = true
    state.lastAttempt = Date.now()

    setTimeout(() => {
      const run = async () => {
        try {
          await state.agent.runMaintenance((signal) => compaction.compactNow(state.agent, signal))
          // 压缩成功后 surface 已变，下一轮的 usage 会重新给出真实规模。
          state.tokens = -1
          warn(ctx, '上下文 ' + triggerTokens + ' tokens 超过阈值，已自动压缩。')
        } catch (error) {
          warn(ctx, '自动压缩失败（下轮重试）：' + (error && error.message ? error.message : String(error)))
        } finally {
          state.busy = false
        }
      }
      void run()
    }, CLAIM_DELAY_MS)
  }

  ctx.on('agent/created', ({ agent }) => {
    track(agent)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    if (agent && agent.session) sessions.delete(agent.session.id)
  })

  ctx.on('session/disposed', (session) => {
    if (session) sessions.delete(session.id)
  })

  ctx.on('session/event', (session, event) => {
    if (!session || !event) return
    const state = sessions.get(session.id)
    if (!state) return

    if (event.type === 'assistant/message') {
      const tokens = contextTokensOf(event.data && event.data.usage)
      if (tokens >= 0) state.tokens = tokens
      return
    }

    if (event.type === 'turn/end') {
      schedule(state, state.tokens)
    }
  })

  // compaction 是可选的：缺少它时插件保持不活动，而不是加载失败。
  ctx.effect(() => ctx.inject(['compaction'], (scoped) => {
    compaction = scoped.compaction
  }))
}
