/**
 * 经验库：读 `~/.dsh/tacit/experiences/*.md`，按信号路径匹配。
 *
 * 一条经验是「条件 + 动作 + 理由」：
 *
 *   ---
 *   id: zip-archive
 *   trigger: file.created
 *   condition: true          # 目前只认 true / 简单 == 比较
 *   action: 归到 archive/zip 下
 *   trust_level: L3
 *   ---
 *   # 标题
 *   理由正文
 *
 * 命中才注入评估上下文：没命中的经验一个字都不进 prompt，
 * 所以经验可以越攒越多，提示词不会越来越长。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Experience {
  id: string
  trigger: string
  condition: string
  action: string
  trust: string
  title: string
  body: string
  file: string
}

const DIR = (): string => process.env.TACIT_EXPERIENCE_DIR ?? join(homedir(), '.dsh', 'tacit', 'experiences')

function parse(text: string, file: string): Experience | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return undefined
  const [, header = '', rawBody = ''] = m
  const front: Record<string, string> = {}
  for (const line of header.split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line.trim())
    if (pair) front[pair[1]!] = pair[2]!.trim()
  }
  const body = rawBody.trim()
  const id = front.id || file.replace(/\.md$/i, '')
  if (!id || !front.trigger) return undefined
  if (front.enabled === 'false') return undefined
  return {
    id,
    trigger: front.trigger,
    condition: front.condition ?? 'true',
    action: front.action ?? '',
    trust: (front.trust_level ?? 'L3').toUpperCase(),
    title: (/^#\s+(.+)$/m.exec(body)?.[1] ?? id).trim(),
    body,
    file,
  }
}

/** 读整个目录；目录不存在就当没有经验，不抛错。 */
export function loadExperiences(dir = DIR()): Experience[] {
  let names: string[]
  try {
    names = readdirSync(dir).filter(name => name.endsWith('.md'))
  } catch {
    return []
  }
  const out: Experience[] = []
  for (const name of names) {
    const file = join(dir, name)
    try {
      if (!statSync(file).isFile()) continue
      const parsed = parse(readFileSync(file, 'utf8'), file)
      if (parsed) out.push(parsed)
    } catch {
      /* 一个坏文件不该让整库读不出来 */
    }
  }
  return out
}

/** `file.*` 匹配 file.created；`file.created` 精确匹配；`**` 全收。 */
export function triggerMatches(trigger: string, path: string): boolean {
  const t = String(trigger ?? '').trim()
  if (!t || !path) return false
  if (t === '**' || t === '*') return true
  if (t.endsWith('.**')) return path === t.slice(0, -3) || path.startsWith(t.slice(0, -2))
  if (t.includes('*')) {
    const re = new RegExp(`^${t.split('.').map(s => (s === '*' ? '[^.]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('\\.')}$`)
    return re.test(path)
  }
  if (path === t || path.startsWith(`${t}.`)) return true
  // 同族匹配：`file.created` 也适用于 `file.modified` / `file.deleted`——
  // 经验写的是「来了一个文件该怎么办」，文件是被创建还是被改名，不该决定它适不适用。
  const want = t.split('.')
  const got = path.split('.')
  return want.length === got.length && want.length > 1 &&
    want.slice(0, -1).join('.') === got.slice(0, -1).join('.')
}

/** 条件只支持 `true` 与 `字段 == 值`，够用且不会误判。 */
export function conditionHolds(condition: string, context: Record<string, unknown>): boolean {
  const c = String(condition ?? 'true').trim()
  if (!c || c === 'true') return true
  if (c === 'false') return false
  const pick = (path: string): unknown =>
    path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), context)
  const eq = /^([A-Za-z_][\w.]*)\s*==\s*(.+)$/.exec(c)
  if (eq) return String(pick(eq[1]!) ?? '') === eq[2]!.trim().replace(/^["']|["']$/g, '')
  // `file.extension in ["pdf", "docx"]`：经验里最常用的一种写法，必须认。
  const inList = /^([A-Za-z_][\w.]*)\s+in\s+\[(.*)\]$/.exec(c)
  if (inList) {
    const allowed = inList[2]!.split(',').map(x => x.trim().replace(/^["']|["']$/g, '').toLowerCase())
    return allowed.includes(String(pick(inList[1]!) ?? '').toLowerCase())
  }
  // A condition this parser does not understand matches nothing: acting on a guess is worse than staying quiet.
  return false
}

/** 命中这个信号的经验，按 id 排序，最多 `limit` 条。 */
export function matchExperiences(path: string, context: Record<string, unknown>, limit = 3): Experience[] {
  return loadExperiences()
    .filter(exp => triggerMatches(exp.trigger, path) && conditionHolds(exp.condition, context))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, limit)
}

/** 拼成给模型看的一小段；没有命中就返回空串。 */
export function experienceBlock(matches: Experience[]): string {
  if (matches.length === 0) return ''
  const lines = ['', '[经验 · 命中这些就按它办]']
  for (const exp of matches) {
    lines.push(`- ${exp.id}（${exp.trust}）：当 ${exp.trigger}${exp.action ? `，就 ${exp.action}` : ''}`)
    if (exp.title && exp.title !== exp.id) lines.push(`  理由：${exp.title}`)
  }
  return lines.join('\n')
}
