/**
 * MSP source kind: the machine itself speaks.
 *
 * Every other Source in this prototype is a remote API we *poll* (`github-trigger.ts`,
 * `feishu-loops.ts` → `poll.ts`). MSP is the other shape: a local node network where the
 * publisher pushes and never learns who received it. So this kind has **no cursor, no
 * polling horizon, and no backoff** — a signal either arrives or the node is gone.
 *
 * The transport is `msp-ts`, vendored under `vendor/msp-ts` and driven in-process:
 * no child process, no Python, no stdout parsing. The old Python bridge lives on the
 * `legacy/python-bridge` branch.
 *
 * Trigger mapping: one signal → one Trigger. `threads[0]` is the signal's *topic* (the first
 * two path segments, e.g. `file.created`), so follow-ups on the same topic reach the same
 * Worker through the existing subscription/direct-pass machinery.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { createInterface } from 'node:readline'

import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'

import type { Trigger } from '../core/index.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { experienceBlock, loadExperiences, matchExperiences } from './experiences.ts'
import { registerExperienceTools } from './experience-tools.ts'
import { registerMspActTools, mspMesh, setMspMesh, type MspMesh } from './msp-act.ts'

export const SOURCE = 'msp'

export const MspConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Signal path globs the bridge subscribes to; `**` is everything the node hears.
   *  The panel edits this as `rows` with one `path` column, so the stored shape is objects. */
  paths: z.array(z.object({ path: z.string() })).default([{ path: '**' }]),
  /** Name this node announces under; a second Super-agent on the machine needs another. */
  nodeName: z.string().default('superagent'),
  /** Signals whose payload marks a person as the author become human Triggers. */
  humanPaths: z.array(z.string()).default(['human.message', 'notify.message']),
})
export type MspConfig = z.infer<typeof MspConfigSchema>

/** The topic a signal belongs to: `file.created.C:\x\y.zip` → `file.created`. */
export const topicOf = (path: string): string => {
  const parts = String(path ?? '').split('.').filter(Boolean)
  return parts.length <= 2 ? parts.join('.') || 'msp' : parts.slice(0, 2).join('.')
}

/** Deterministic id so a bridge restart that replays a signal does not double-open a ticket. */
export const mspTriggerId = (node: string, path: string, at: string, payload: unknown): string =>
  `msp:${node}:${path}:${at}:${JSON.stringify(payload ?? null).slice(0, 120)}`

/** Turns one bridge line into the domain's Trigger; exposed for tests. */
export function mspTrigger(event: {
  node?: string; path?: string; at?: string; payload?: unknown; human?: boolean
}, config: Pick<MspConfig, 'humanPaths'>): Trigger | undefined {
  const path = String(event.path ?? '').trim()
  if (!path) return undefined
  const at = typeof event.at === 'string' && !Number.isNaN(Date.parse(event.at)) ? event.at : new Date().toISOString()
  const node = String(event.node ?? 'msp')
  const payload = event.payload ?? {}
  const human = event.human === true || config.humanPaths.some(prefix => path === prefix || path.startsWith(`${prefix}.`))
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload).slice(0, 2000)
  return {
    id: mspTriggerId(node, path, at, payload),
    source: SOURCE,
    threads: [{ source: SOURCE, id: topicOf(path) }],
    // A machine signal has no sender: an empty actor id makes it a senderless
    // event, which the Policy admits as an `inferred` candidate instead of
    // pretending a person asked for work.
    actor: { source: SOURCE, id: human ? node : '' },
    human,
    addressed: human ? 'direct' : undefined,
    at,
    text: `${path}\n${text}`,
    meta: { mspPath: path, mspNode: node, mspPayload: payload, topic: topicOf(path) },
  }
}

export const mspKind: SourceKind<MspConfig> = {
  kind: SOURCE,
  title: { zh: '本机 MSP 节点', en: 'Local MSP nodes' },
  description: {
    zh: '本机软件主动推来的信号（文件、剪贴板、进程、任何宣告了自己的节点）。不轮询。',
    en: 'Signals pushed by local software (files, clipboard, processes, any node that announces itself). No polling.',
  },
  schema: MspConfigSchema,
  fields: [
    { key: 'paths', label: { zh: '订阅的信号路径', en: 'Signal paths' }, hint: { zh: '例如 **、file.**、notify.message', en: 'e.g. **, file.**, notify.message' }, type: 'rows', columns: [{ key: 'path', label: { zh: '路径', en: 'Path' }, type: 'text' }] },
    { key: 'nodeName', label: { zh: '本节点名称', en: 'Node name' }, type: 'text' },
  ],
  health: ['msp'],
  /**
   * Every MSP signal is in scope and observed (we produce all of them, there is no
   * membership list to filter by). `row` names the admission row the Policy looks up:
   * `policy.sources.msp.admission.ambient.unlistedUnaddressed` must be `inferred`,
   * otherwise machine events are ignored — see README.md.
   */
  scope: () => ({ listened: true, observed: true, row: 'ambient' }),
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_MSP_TOPIC', description: { zh: '触发本工单的 MSP 信号主题', en: 'The MSP topic that started this ticket' } }],
    values: ({ trigger }) => ({ DSH_SUPERAGENT_MSP_TOPIC: trigger?.source === SOURCE ? String(trigger.meta.topic ?? '') : '' }),
  },
}

const available = (ctx: SourceContext): MspConfig | undefined => {
  const config = ctx.config<MspConfig>(SOURCE)
  if (!config || config.enabled === false) {
    ctx.report('msp', health('paused', 'sourceOff'))
    return undefined
  }
  return config
}

/**
 * Drive MSP in-process with `msp-ts`: no child process, no Python, no stdout parsing.
 *
 * The Python bridge stays in `python/msp_bridge.py` for hosts without a Node MSP build,
 * but it is no longer the path the service takes — one less moving part, one less install step.
 */
/** 上一次启动的节点。插件会重载，旧节点不停就会占着租约和端口，新节点抢不到连接。 */
let currentNode: { stop(): void } | null = null

/** 本补丁用到的节点形状：听 + 说 + 看得见邻居。声明窄一点，vendor 换实现也不用改这里。 */
type MspNode = MspMesh & {
  on(p: string, cb: (sig: any) => void): unknown
  start(): Promise<unknown>
  stop(): void
}

export async function runMsp(ctx: SourceContext, signal: AbortSignal): Promise<unknown> {
  const config = available(ctx)
  if (!config) return
  if (currentNode) {
    try { currentNode.stop() } catch { /* 已经没了 */ }
    currentNode = null
    setMspMesh(null)
  }
  const globs = (config.paths ?? []).map(entry => entry?.path).filter(Boolean)
  const patterns = globs.length > 0 ? globs : ['**']

  let node: MspNode
  try {
    const mod = (await import('msp-ts')) as { MSPNode: new (id: string, opts?: Record<string, unknown>) => MspNode }
    node = new mod.MSPNode(config.nodeName, { connectPolicy: 'eager' })
  } catch (error) {
    ctx.report('msp', { state: 'error', detail: `msp-ts unavailable: ${String(error).slice(0, 200)}` })
    return
  }

  let seen = 0
  // 兜底去重：本机信号源可能重复推送（实测过每秒一条的风暴）。
  // 引擎不限流，所以同一个文件在窗口内只受理一次，否则每个重复事件都会烧一次模型调用。
  const recent = new Map<string, number>()
  const DEDUPE_WINDOW_MS = 60_000
  let suppressed = 0
  for (const pattern of patterns) {
    node.on(pattern, sig => {
      // 先报告一次「回调真的进来了」，再判断能不能用——否则死在这里是黑盒。
      ctx.report('msp', { state: 'ready', detail: `hit ${pattern}: ${JSON.stringify(sig).slice(0, 140)}` })
      if (signal.aborted) return
      const key = `${String(sig?.path)}|${String((sig?.payload as any)?.name ?? '')}|${String((sig?.payload as any)?.bytes ?? '')}`
      const at = Date.now()
      const last = recent.get(key) ?? 0
      if (at - last < DEDUPE_WINDOW_MS) {
        suppressed += 1
        return
      }
      recent.set(key, at)
      if (recent.size > 500) {
        for (const [k, v] of recent) if (at - v > DEDUPE_WINDOW_MS) recent.delete(k)
      }
      const trigger = mspTrigger({
        node: sig?.source ?? config.nodeName,
        path: sig?.path,
        at: typeof sig?.at === 'number' ? new Date(sig.at).toISOString() : sig?.at,
        payload: sig?.payload,
      }, config)
      if (!trigger) return
      const payload = (trigger.meta.mspPayload ?? {}) as Record<string, unknown>
      const named = String(payload.name ?? payload.path ?? '')
      const extension = named.includes('.') ? named.split('.').pop()!.toLowerCase() : ''
      const hits = matchExperiences(trigger.meta.mspPath as string, {
        ...trigger.meta,
        payload,
        file: { name: named, extension },
        signal: { path: trigger.meta.mspPath },
      })
      const block = experienceBlock(hits)
      if (block) trigger.text = `${trigger.text}
${block}`
      // 把命中写进 meta：否则「这条经验生效了吗」在决策记录里查不到，也就无法做消融。
      trigger.meta.experience = hits.map(h => h.id)
      trigger.meta.experienceLoaded = loadExperiences().length
      seen += 1
      ctx.report('msp', {
        state: 'ready',
        detail: `listening: ${patterns.join(', ')} · seen ${seen} · exp ${hits.length}/${loadExperiences().length}${hits.length ? ` · 经验 ${hits.map(h => h.id).join(',')}` : ''} · path ${String(trigger.meta.mspPath)}${suppressed ? ` · 去重 ${suppressed}` : ''}`,
      })
      Promise.resolve(ctx.receive(trigger))
        .then(result => {
          ctx.report('msp', { state: 'ready', detail: `recv ${JSON.stringify(result).slice(0, 160)}` })
        })
        .catch(error => {
          ctx.report('msp', { state: 'error', detail: `receive failed: ${String(error).slice(0, 240)}` })
        })
    })
  }

  try {
    await node.start()
  } catch (error) {
    ctx.report('msp', { state: 'error', detail: `msp node start failed: ${String(error).slice(0, 200)}` })
    return
  }
  currentNode = node
  // 补丁一：把活着的节点交给工具层。`msp_nodes` 靠它列邻居，`msp_publish` / `msp_call`
  // 靠它往网格里说话——「一切皆节点，一切皆信号」在这里落地，不在协议里落地。
  setMspMesh(node)
  ctx.report('msp', { state: 'ready', detail: `listening: ${patterns.join(', ')}` })
  signal.addEventListener('abort', () => {
    try { node.stop() } catch { /* already gone */ }
    // 只清掉自己：插件重载时新节点可能已经挂上了，别把新的抹了。
    if (mspMesh() === node) setMspMesh(null)
  }, { once: true })
  return undefined
}

export const name = 'dsh-superagent-msp'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(mspKind), 'msp: source kind')

  // 两组工具，各自对应一块：
  //   经验 CRUD：模型能自己读、写、改、停用——否则经验库只能靠人喂，永远长不大；
  //   接入（补丁一）：看得见节点、发得出信号、调得动工具——接新设备不再需要写适配。
  ctx.inject(['tools'], (tctx: Context) => {
    const tools = (tctx as unknown as { tools: { register(def: unknown): unknown } }).tools
    const disposers = [
      ...registerExperienceTools(tools),
      ...registerMspActTools(tools),
    ]
    tctx.effect(() => () => {
      for (const dispose of disposers) {
        try { (dispose as () => void)() } catch { /* 已摘除 */ }
      }
    }, 'msp: experience + act tools')
  })
  ctx.effect(() => {
    const controller = new AbortController()
    const running = runMsp(sourceContext(ctx.orchestrator, mspKind), controller.signal)
    return async () => { controller.abort(); await running }
  })
}

export type { Localized }
