/**
 * 经验的 CRUD：让模型自己读、写、改、删。
 *
 * 为什么要有这一组工具：经验如果只能由人手写，它就永远长不大。模型在干活时
 * 最清楚「刚才那次判断的依据是什么」，让它当场把这条写下来，比事后回顾准得多。
 *
 * 落盘就是 `~/.dsh/tacit/experiences/<id>.md`（YAML 头 + 正文），
 * 与 `experiences.ts` 的读取逻辑、以及 tacit 那边完全同格式——
 * 所以人改文件、模型调工具，看到的是同一份东西。
 *
 * 四条硬约束（写在代码里，不靠提示词自觉）：
 *   1. id 只允许 `[a-z0-9-]`，且不许覆盖已有文件（要改就 update）；
 *   2. 新建的等级最高只能是 L3（先问后做），L1/L2 必须由人上调；
 *   3. delete 是软删（enabled: false），真删要人来；
 *   4. 每次写都记 `taught_by` 与时间，没有出处的规则就是迷信。
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DIR = (): string => process.env.TACIT_EXPERIENCE_DIR ?? join(homedir(), '.dsh', 'tacit', 'experiences')
const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
const LEVELS = ['L1', 'L2', 'L3', 'L4']

interface Draft {
  id: string
  trigger: string
  condition?: string
  action: string
  trust?: string
  title?: string
  body?: string
}

function render(d: Draft): string {
  return [
    '---',
    `id: ${d.id}`,
    `trigger: ${d.trigger}`,
    `condition: ${d.condition ?? 'true'}`,
    `action: ${(d.action ?? '').replace(/\s*\n\s*/g, ' ').trim()}`,
    `trust_level: ${d.trust ?? 'L3'}`,
    'scope: local',
    'enabled: true',
    `taught_by: agent`,
    `taught_at: ${new Date().toISOString()}`,
    '---',
    '',
    `# ${d.title ?? d.action.slice(0, 40)}`,
    '',
    d.body ?? '',
    '',
  ].join('\n')
}

/** Returns the level to store and whether the model asked for one it may not set. */
function clampTrust(input: string | undefined): { level: string; clamped: boolean } {
  const level = String(input ?? 'L3').toUpperCase()
  if (!LEVELS.includes(level)) return { level: 'L3', clamped: false }
  // 模型自建的经验不许直接拿 L1/L2：那是可以不经人点头就行动的等级。
  return level === 'L1' || level === 'L2' ? { level: 'L3', clamped: true } : { level, clamped: false }
}

const OUT = { type: 'object', properties: { content: { type: 'array', items: {} }, structuredContent: {} }, required: ['content'], additionalProperties: false }

/** 这组的注册函数由 msp.ts 在 `ctx.inject(['tools'])` 里调用。 */
export function registerExperienceTools(tools: { register(def: unknown): unknown }): (() => void)[] {
  const disposers: (() => void)[] = []
  const dir = DIR()

  const list = () => {
    try {
      return readdirSync(dir).filter(n => n.endsWith('.md')).map(n => n.replace(/\.md$/, '')).sort()
    } catch {
      return []
    }
  }

  /**
   * The file an id names, or undefined when the id is not a plain slug. `id` comes from the model, so `..`,
   * separators and drive letters must never reach `join`: without this check `experience_read` would read any `.md`
   * on disk and `experience_update` would rewrite it.
   */
  const fileOf = (id: string): string | undefined => ID_RE.test(id) ? join(dir, `${id}.md`) : undefined

  const read = (id: string) => {
    const file = fileOf(id)
    if (!file) return undefined
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return undefined
    }
  }

  disposers.push(
    tools.register({
      name: 'experience_list',
      description: '列出本机经验库里的所有经验 id。经验是「当…就…」的规则，会按信号路径自动命中并注入上下文。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: OUT, render: (_a: unknown, v: any) => [{ type: 'text', text: v.structuredContent.ids.join('\n') }] },
      execute: async () => {
        const ids = list()
        return { content: [{ type: 'text', text: ids.join('\n') }], structuredContent: { ids } }
      },
    }) as () => void,
  )

  disposers.push(
    tools.register({
      name: 'experience_read',
      description: '读一条经验的完整内容（含条件、动作、等级和正文）。',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      output: { schema: OUT, render: (_a: unknown, v: any) => [{ type: 'text', text: v.structuredContent.text }] },
      execute: async (args: any) => {
        const text = read(String(args?.id ?? ''))
        return { content: [{ type: 'text', text: text ?? '(没有这条经验)' }], structuredContent: { text: text ?? '', found: Boolean(text) } }
      },
    }) as () => void,
  )

  disposers.push(
    tools.register({
      name: 'experience_create',
      description: [
        '新建一条经验。只在「这次判断有可复用的理由」时用：一条规则一个文件，别攒大杂烩。新建的等级最高 L3。',
        '',
        '写之前先自检，四条缺一不可：',
        '1. 可执行 —— action 必须写清「做什么 + 用什么做」，例如「用 report 交付一句结果」「移动到 ~/Documents/Work/」，',
        '   不能只写意图（「弹一个轻量通知」「处理一下」「归档」这类都不可执行，执行者会自己发明实现）。',
        '2. 有边界 —— 明确写出不许做什么（「不读无关目录」「不查系统数据库」「不自己造弹窗」）。',
        '3. 条件可判定 —— condition 只支持 true、`字段 == 值`、`字段 in [..]`；写别的等于永不命中，而且不会报错。',
        '4. 等级克制 —— 默认 L3（先问后做），这条规则跑顺很多次之后再考虑降级。',
        '',
        '反例：「弹一个轻量通知」—— 实测让执行者花了 48 秒、几十轮调用，还去翻系统通知数据库。',
        '正例：「只做三件事：判断 → 移动到 ~/Documents/Work/ → 用 report 交付一句结果；不读无关目录」。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '小写字母数字和连字符，例如 installer-ask' },
          trigger: { type: 'string', description: '信号路径，支持 file.** 或 file.created' },
          action: { type: 'string', description: '命中后做什么' },
          condition: { type: 'string', description: '可选，默认 true' },
          trust_level: { type: 'string', enum: LEVELS, description: '默认 L3' },
          title: { type: 'string' },
          body: { type: 'string', description: '为什么——这条经验的理由' },
        },
        required: ['id', 'trigger', 'action'],
        additionalProperties: false,
      },
      output: { schema: OUT, render: (_a: unknown, v: any) => [{ type: 'text', text: v.structuredContent.message }] },
      execute: async (args: any) => {
        const id = String(args?.id ?? '')
        if (!ID_RE.test(id)) {
          return { content: [{ type: 'text', text: `id 不合法：${id}` }], structuredContent: { ok: false, message: 'id 不合法' } }
        }
        if (existsSync(join(dir, `${id}.md`))) {
          return { content: [{ type: 'text', text: `已存在同 id 的经验：${id}，要改请用 experience_update` }], structuredContent: { ok: false, message: '已存在' } }
        }
        mkdirSync(dir, { recursive: true })
        const trust = clampTrust(args.trust_level)
        writeFileSync(join(dir, `${id}.md`), render({
          id,
          trigger: String(args.trigger),
          condition: args.condition ? String(args.condition) : undefined,
          action: String(args.action),
          trust: trust.level,
          title: args.title ? String(args.title) : undefined,
          body: args.body ? String(args.body) : undefined,
        }), 'utf8')
        // Say so instead of pretending: a clamped level that reports success leaves the model and the file disagreeing.
        const message = trust.clamped
          ? `已写入 ${id}.md，等级按 L3 落盘：L1/L2 是不经确认就行动的等级，模型不能自授，要降级只能由人在 ${id}.md 里改 trust_level。`
          : `已写入 ${id}.md`
        return { content: [{ type: 'text', text: message }], structuredContent: { ok: true, message, id, trust_level: trust.level } }
      },
    }) as () => void,
  )

  disposers.push(
    tools.register({
      name: 'experience_update',
      description: [
        '改一条已有经验。只传要改的字段。等级最高 L3（降级与放宽要人来定）。',
        '改 action 时同样要满足可执行与有边界：写清「做什么 + 用什么做」，并写明不许做什么。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          trigger: { type: 'string' },
          action: { type: 'string' },
          condition: { type: 'string' },
          trust_level: { type: 'string', enum: LEVELS },
          body: { type: 'string' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: { schema: OUT, render: (_a: unknown, v: any) => [{ type: 'text', text: v.structuredContent.message }] },
      execute: async (args: any) => {
        const id = String(args?.id ?? '')
        const text = read(id)
        if (!text) return { content: [{ type: 'text', text: `没有这条经验：${id}` }], structuredContent: { ok: false, message: '没有' } }
        const patch: Record<string, string> = {}
        for (const key of ['trigger', 'action', 'condition']) if (typeof args?.[key] === 'string') patch[key] = args[key]
        let out = text
        // A function replacer, so `$&`, `$'` and `` $` `` in the value are written literally instead of being expanded.
        for (const [key, value] of Object.entries(patch)) {
          const line = `${key}: ${value.replace(/\s*\n\s*/g, ' ')}`
          out = out.replace(new RegExp(`^${key}:.*$`, 'm'), () => line)
        }
        const trust = typeof args?.trust_level === 'string' ? clampTrust(args.trust_level) : undefined
        if (trust) out = out.replace(/^trust_level:.*$/m, `trust_level: ${trust.level}`)
        writeFileSync(fileOf(id)!, out, 'utf8')
        // A downgrade to L1/L2 is the model granting itself the right to act unasked; report that it did not happen.
        if (trust?.clamped) {
          const message = `等级没有改：L1/L2 是不经确认就行动的等级，模型不能自授，${id}.md 里仍是 L3。` +
            `${Object.keys(patch).length ? '其他字段已更新。' : ''}要降级只能由人在这个文件里改 trust_level。`
          return { content: [{ type: 'text', text: message }], structuredContent: { ok: false, message, id, trust_level: 'L3' } }
        }
        return { content: [{ type: 'text', text: `已更新 ${id}` }], structuredContent: { ok: true, message: `已更新 ${id}`, id, ...trust ? { trust_level: trust.level } : {} } }
      },
    }) as () => void,
  )

  disposers.push(
    tools.register({
      name: 'experience_disable',
      description: '停用一条经验（软删，文件留着）。它不会再被命中，但还能查回来。真删要人来做。',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      output: { schema: OUT, render: (_a: unknown, v: any) => [{ type: 'text', text: v.structuredContent.message }] },
      execute: async (args: any) => {
        const id = String(args?.id ?? '')
        const text = read(id)
        if (!text) return { content: [{ type: 'text', text: `没有这条经验：${id}` }], structuredContent: { ok: false, message: '没有' } }
        // Keep the file's own line ending: a CRLF frontmatter never matches `^---\n`, and the write would "succeed" unmodified.
        const out = /^enabled:/m.test(text) ? text.replace(/^enabled:.*$/m, 'enabled: false')
          : text.replace(/^---(\r?\n)/, (_match, eol: string) => `---${eol}enabled: false${eol}`)
        writeFileSync(fileOf(id)!, out, 'utf8')
        return { content: [{ type: 'text', text: `已停用 ${id}` }], structuredContent: { ok: true, message: `已停用 ${id}`, id } }
      },
    }) as () => void,
  )

  return disposers
}
