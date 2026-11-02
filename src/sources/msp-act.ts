/**
 * 补丁一 · 接入：一切皆节点，一切皆信号。
 *
 * 上一版只做了「收」：本机软件主动推信号，Agent 听得见。但那时候 Agent 只**收**，不能**说**——
 * 于是「接入」实际上还是一次性的单向适配：每接一台设备，都要有人写一个发布端，接不上的永远看不见。
 *
 * 这一版补上另一半，把「接入」变成协议而不是工作量：
 *
 *   - **一切皆节点**：任何进程只要能宣告自己，就是一个节点。`msp_nodes` 让 Agent 看见
 *     本机有谁、各自声明了什么能力（信号路径 + 可调工具）——不需要为每台设备写适配。
 *   - **一切皆信号**：动作也是信号。`msp_publish` 往任意路径发一条，谁订阅谁处理。
 *     于是「开灯」「暂停下载」「广播一条状态」在 Agent 眼里是同一件事，没有设备特判。
 *   - **请求/响应**：需要拿回结果的（读传感器、要一次计算），`msp_call` 直接调对端声明的工具。
 *
 * 三条加起来才是「接不上的，Agent 就永远看不见」的反面：**接得上的，不需要为它改代码。**
 */

/** msp-ts 的节点接口，只取本补丁用到的部分，免得把 vendor 的类型泄漏进来。 */
export interface MspMesh {
  readonly nodeId: string
  publish(path: string, payload: Record<string, unknown>): void
  neighbors(): string[]
  connections(): string[]
  peerManifest(peerId: string): Record<string, unknown> | undefined
}

let mesh: MspMesh | null = null

/** 由 `runMsp` 在节点起来之后挂上，停掉时清空；工具在没起来时要说人话，而不是抛错。 */
export function setMspMesh(next: MspMesh | null): void {
  mesh = next
}

export const mspMesh = (): MspMesh | null => mesh

export interface PeerCapability {
  id: string
  /** 对端声明会发的信号路径。 */
  signals: string[]
  /** 对端声明可调的工具。 */
  tools: { name: string; description: string }[]
}

/** 把对端 manifest 归一成「它能干什么」；manifest 是不可信输入，缺字段一律降级成空。 */
export function describePeer(id: string, manifest: Record<string, unknown> | undefined): PeerCapability {
  const signals = Array.isArray(manifest?.signals)
    ? (manifest.signals as unknown[]).flatMap(entry => {
      const path = typeof entry === 'string' ? entry : (entry as { path?: unknown } | null)?.path
      return typeof path === 'string' && path.trim() ? [path.trim()] : []
    })
    : []
  const tools = Array.isArray(manifest?.tools)
    ? (manifest.tools as unknown[]).flatMap(entry => {
      const spec = (entry ?? {}) as { name?: unknown; description?: unknown }
      return typeof spec.name === 'string' && spec.name.trim()
        ? [{ name: spec.name.trim(), description: typeof spec.description === 'string' ? spec.description : '' }]
        : []
    })
    : []
  return { id, signals: [...new Set(signals)].sort(), tools }
}

/** 本机看得见的全部节点。只列邻居——没连上的节点对 Agent 来说等于不存在，这正是「看不见」的含义。 */
export function peerCapabilities(current: MspMesh | null = mesh): PeerCapability[] {
  if (!current) return []
  const ids = [...new Set([...current.neighbors(), ...current.connections()])].sort()
  return ids.map(id => describePeer(id, current.peerManifest(id)))
}

const OUT = { type: 'object', properties: { content: { type: 'array', items: {} }, structuredContent: {} }, required: ['content'], additionalProperties: false }

/** 补丁一的三个工具；由 `msp.ts` 在 `ctx.inject(['tools'])` 里注册。 */
export function registerMspActTools(tools: { register(def: unknown): unknown }): (() => void)[] {
  const disposers: (() => void)[] = []
  const offline = (message: string) => ({ content: [{ type: 'text', text: message }], structuredContent: { ok: false, message } })

  disposers.push(
    tools.register({
      name: 'msp_nodes',
      description: [
        '列出本机 MSP 网格里能看见的节点，以及每个节点声明的能力（会发哪些信号、能调哪些工具）。',
        '这就是「接入」的入口：节点在列表里，就能用 msp_publish / msp_call 直接驱动它，不需要为它单独适配。',
        '不在列表里的节点对你说等于不存在——先把它拉起来（或让它宣告自己），再回来查。',
      ].join('\n'),
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: OUT, render: (_a: unknown, v: any) => [{ type: 'text', text: v.structuredContent.text }] },
      execute: async () => {
        if (!mesh) return offline('MSP 节点还没起来（来源未启用或正在重连）；先确认 msp 来源是开启状态。')
        const peers = peerCapabilities(mesh)
        const text = peers.length === 0
          ? `节点 ${mesh.nodeId} 在线，但暂时没有连上的邻居。`
          : [`本节点：${mesh.nodeId}`, ...peers.map(peer => {
            const signals = peer.signals.length ? peer.signals.join(', ') : '(未声明信号)'
            const toolsText = peer.tools.length ? peer.tools.map(tool => tool.name).join(', ') : '(未声明工具)'
            return `- ${peer.id}｜信号：${signals}｜工具：${toolsText}`
          })].join('\n')
        return { content: [{ type: 'text', text }], structuredContent: { ok: true, text, node: mesh.nodeId, peers } }
      },
    }) as () => void,
  )

  disposers.push(
    tools.register({
      name: 'msp_publish',
      description: [
        '往 MSP 网格发一条信号（一切皆信号：动作也是信号）。任何订阅了这个路径的节点都会收到。',
        '路径用点分小写，例如 device.light.on / download.pause / notify.message；payload 是随信号一起传的字段。',
        '这条工具不关心对面是什么设备——设备叫什么、怎么实现，都不需要你知道。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '信号路径，点分，例如 device.light.on' },
          payload: { type: 'object', description: '随信号传的字段，可选', additionalProperties: true },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: { schema: OUT, render: (_a: unknown, v: any) => [{ type: 'text', text: v.structuredContent.message }] },
      execute: async (args: any) => {
        if (!mesh) return offline('MSP 节点还没起来，信号发不出去。')
        const path = String(args?.path ?? '').trim()
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(path)) return offline(`信号路径不合法：${path}（点分，字母数字下划线和点）`)
        const payload = (args?.payload && typeof args.payload === 'object' ? args.payload : {}) as Record<string, unknown>
        try {
          mesh.publish(path, { ...payload, published_by: mesh.nodeId, published_at: new Date().toISOString() })
        } catch (error) {
          return offline(`发送失败：${String(error).slice(0, 200)}`)
        }
        const message = `已发送 ${path}（${Object.keys(payload).length} 个字段）`
        return { content: [{ type: 'text', text: message }], structuredContent: { ok: true, message, path } }
      },
    }) as () => void,
  )

  disposers.push(
    tools.register({
      name: 'msp_call',
      description: [
        '直接调用某个 MSP 节点声明的工具，并拿回结果（需要返回值的场景用它，发完就走用 msp_publish）。',
        '先 msp_nodes 看对方有哪些工具；工具名必须是对方清单里声明过的。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          peer: { type: 'string', description: '节点 id，例如 file-watcher' },
          tool: { type: 'string', description: '对方声明的工具名' },
          args: { type: 'object', description: '调用参数', additionalProperties: true },
          timeout_ms: { type: 'number', description: '超时，默认 15000' },
        },
        required: ['peer', 'tool'],
        additionalProperties: false,
      },
      output: { schema: OUT, render: (_a: unknown, v: any) => [{ type: 'text', text: v.structuredContent.text }] },
      execute: async (args: any) => {
        if (!mesh) return offline('MSP 节点还没起来，调不了对端。')
        const peer = String(args?.peer ?? '').trim()
        const tool = String(args?.tool ?? '').trim()
        if (!peer || !tool) return offline('peer 和 tool 都不能为空')
        const declared = peerCapabilities(mesh).find(item => item.id === peer)
        if (!declared) return offline(`没有连上节点 ${peer}；先用 msp_nodes 看现在能看见谁。`)
        if (!declared.tools.some(item => item.name === tool)) {
          return offline(`节点 ${peer} 没有声明工具 ${tool}；它声明的是：${declared.tools.map(item => item.name).join(', ') || '(无)'}`)
        }
        const call = (mesh as MspMesh & { call?: (peerId: string, tool: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<unknown> }).call
        if (typeof call !== 'function') return offline('当前 msp-ts 版本不支持 msp_call，只能用 msp_publish 发信号。')
        const timeout = Number.isFinite(args?.timeout_ms) ? Math.min(Math.max(Number(args.timeout_ms), 500), 120_000) : 15_000
        try {
          const result = await call.call(mesh, peer, tool, (args?.args && typeof args.args === 'object' ? args.args : {}) as Record<string, unknown>, timeout)
          const text = typeof result === 'string' ? result : JSON.stringify(result).slice(0, 4000)
          return { content: [{ type: 'text', text }], structuredContent: { ok: true, text } }
        } catch (error) {
          return offline(`调用 ${peer}/${tool} 失败：${String(error).slice(0, 240)}`)
        }
      },
    }) as () => void,
  )

  return disposers
}
