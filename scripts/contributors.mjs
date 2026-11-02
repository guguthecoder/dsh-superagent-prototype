#!/usr/bin/env node
/**
 * 生成 README 的贡献者墙。
 *
 * 两个来源，缺一不可：
 *   1. contributors.json —— 人在这里声明。历史被 rebase 掉的人、没有 GitHub 账号的人、
 *      上游原型的作者，只有这里能记住他们。
 *   2. GitHub contributors API —— 只用来补提交数；声明里带了 login 的人自动取数。
 *   API 里出现的、声明里没写的新人，自动追加在后面，不至于漏掉。
 *
 * 只写 README 里 `<!-- contributors:start -->` 与 `<!-- contributors:end -->` 之间的内容，
 * 标记之外一个字节都不动；换行符沿用文件原有的（CRLF/LF）。
 *
 * 用法：
 *   node scripts/contributors.mjs               # 改写 README.md
 *   node scripts/contributors.mjs --check       # 只检查，过期就退出码 1（CI 用）
 *   node scripts/contributors.mjs --print       # 打印生成的块，不写文件
 *
 * 环境变量：GITHUB_TOKEN / GH_TOKEN（有就用，避开匿名 60 次/小时的限流）、
 * GITHUB_REPOSITORY（Actions 自带）。都没有时退回到 origin remote。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export const START_MARKER = '<!-- contributors:start -->'
export const END_MARKER = '<!-- contributors:end -->'

const LOGIN = /^[A-Za-z0-9-]+$/
const HTTP = /^https?:\/\//i

/** 机器人也进墙，只是副标题里标出来：谁看都知道这行不是人。 */
const autoNote = (entry) => `${Number(entry.contributions) || 0} 次提交${entry.bot ? ' · 机器人' : ''}`

/** 副标题的组装顺序：身份（维护者）在前，然后是提交数。 */
const noteOf = (maintainer, entry) => {
  const parts = []
  if (maintainer) parts.push('维护者')
  if (entry) parts.push(autoNote(entry))
  return parts.length ? parts.join(' · ') : undefined
}

/**
 * 从 `git remote get-url origin` 的各种写法里取出 `owner/repo`。
 * 支持 git@host:owner/repo.git、https://user:token@host/owner/repo.git、ssh://……
 */
export function parseRepo(remote) {
  const text = String(remote ?? '').trim()
  const match = text.match(/^(?:[a-z+]+:\/\/[^/]*@?[^/]*\/|git@[^:]+:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i)
  if (!match) throw new Error(`无法从 remote 解析出 owner/repo：${text || '(空)'}`)
  return `${match[1]}/${match[2]}`
}

export function chunk(items, size) {
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** 表格里出现的账号名要当 HTML 转义，避免异常字符把标签撑破。 */
export function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 没有头像的人：用 GitHub 自己的 identicon，按名字散列，稳定且不用第三方。 */
export function identicon(seed) {
  return `https://github.com/identicons/${createHash('md5').update(String(seed)).digest('hex')}.png`
}

/**
 * 过滤 + 去重 + 排序。同一账号大小写不同要合并（GitHub 允许改大小写）。
 * 匿名贡献者（没有 login）跳过：没有稳定的主页可链。
 * 机器人保留——它真的提交了东西（比如 CI 重建 lib），只是打上 bot 标记。
 */
export function normalize(raw) {
  const byLogin = new Map()
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const login = typeof entry.login === 'string' ? entry.login.trim() : ''
    if (!login) continue
    const key = login.toLowerCase()
    const contributions = Number(entry.contributions) || 0
    const previous = byLogin.get(key)
    if (previous) {
      previous.contributions += contributions
      previous.bot ||= entry.type === 'Bot' || /\[bot\]$/i.test(key)
      continue
    }
    byLogin.set(key, {
      login,
      contributions,
      bot: entry.type === 'Bot' || /\[bot\]$/i.test(key),
      // 机器人没有 github.com/<login>.png 这种图，头像和主页都用 API 给的。
      url: typeof entry.html_url === 'string' && entry.html_url ? entry.html_url : `https://github.com/${login}`,
      avatar:
        typeof entry.avatar_url === 'string' && entry.avatar_url
          ? entry.avatar_url
          : `https://github.com/${login}.png`,
    })
  }
  return [...byLogin.values()].sort(
    (a, b) => b.contributions - a.contributions || (a.login.toLowerCase() < b.login.toLowerCase() ? -1 : 1),
  )
}

/** 校验 contributors.json，字段写错就报错——这里只有一个地方会改，别让它悄悄变脏。 */
export function normalizeCredits(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('contributors.json 必须是一个对象')
  const repo = raw.repo === undefined ? undefined : String(raw.repo).trim()
  if (repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`contributors.json 的 repo 不是 owner/name：${repo}`)
  const people = raw.people ?? []
  if (!Array.isArray(people)) throw new Error('contributors.json 里要有 people 数组')
  const list = people.map((person, index) => {
    const where = `contributors.json 第 ${index + 1} 个贡献者`
    if (!person || typeof person !== 'object') throw new Error(`${where} 不是对象`)
    const name = typeof person.name === 'string' ? person.name.trim() : ''
    if (!name) throw new Error(`${where} 缺 name`)
    const login = person.login === undefined ? undefined : String(person.login).trim()
    if (login !== undefined && !LOGIN.test(login)) throw new Error(`${where} 的 login 不是合法 GitHub 用户名：${login}`)
    for (const field of ['url', 'avatar']) {
      if (person[field] !== undefined && !HTTP.test(String(person[field]))) throw new Error(`${where} 的 ${field} 必须是 http(s) 地址`)
    }
    const note = person.note === undefined ? undefined : String(person.note).trim() || undefined
    if (person.maintainer !== undefined && typeof person.maintainer !== 'boolean') {
      throw new Error(`${where} 的 maintainer 只能是 true / false`)
    }
    return { name, login, url: person.url, avatar: person.avatar, note, maintainer: person.maintainer === true }
  })
  return { repo, people: list }
}

/**
 * 维护者永远排最前，多人时按声明顺序——也就是加入顺序（JSON 里从上到下写）。
 * 其次是其他声明的人（同按声明顺序），最后是 API 里发现的新人。
 * 声明的人如果有 login，就拿 API 的提交数；没有就只用 note。
 */
export function buildCards(people, discovered, { onWarn = () => {} } = {}) {
  const byLogin = new Map(discovered.map((entry) => [entry.login.toLowerCase(), entry]))
  const taken = new Set()
  const cards = []
  // Array.prototype.sort 是稳定的：同组内保持声明顺序。
  const ordered = [...people].sort((a, b) => Number(Boolean(b.maintainer)) - Number(Boolean(a.maintainer)))

  for (const person of ordered) {
    const key = (person.login ?? person.name).toLowerCase()
    if (taken.has(key)) {
      onWarn(`contributors.json 里重复声明了 ${person.name}，跳过`)
      continue
    }
    const found = person.login ? byLogin.get(person.login.toLowerCase()) : undefined
    for (const id of [key, found?.login.toLowerCase()]) {
      if (id) taken.add(id)
    }
    cards.push({
      name: person.name,
      url: person.url ?? found?.url ?? (person.login ? `https://github.com/${person.login}` : undefined),
      avatar:
        person.avatar ??
        found?.avatar ??
        (person.login ? `https://github.com/${person.login}.png` : identicon(person.name)),
      note: person.note ?? noteOf(person.maintainer, found),
      bot: found?.bot ?? false,
      maintainer: Boolean(person.maintainer),
    })
  }

  for (const entry of discovered) {
    if (taken.has(entry.login.toLowerCase())) continue
    cards.push({ name: entry.login, url: entry.url, avatar: entry.avatar, note: autoNote(entry), bot: entry.bot, maintainer: false })
  }
  return cards
}

/** 渲染标记之间的内容（LF 换行；写入时再统一成文件原有的换行符）。 */
export function renderWall(cards, { repo, limit = 24, perRow = 6 } = {}) {
  const shown = cards.slice(0, Math.max(1, limit))
  const hidden = cards.length - shown.length
  const lines = ['<!-- 由 scripts/contributors.mjs 生成，名单看 contributors.json；CI 刷新，勿手改本块 -->', '']

  if (!shown.length) {
    lines.push('_还没有贡献者记录——GitHub 只统计进入默认分支的提交。_')
    return lines.join('\n')
  }

  lines.push('<table>')
  for (const row of chunk(shown, perRow)) {
    lines.push('  <tr>')
    for (const card of row) {
      const name = escapeHtml(card.name)
      const note = card.note ? escapeHtml(card.note) : ''
      const title = note ? `${name} · ${note}` : name
      // 一格就是一个图标：72px 头像，点了进主页；名字和事由在下面，字号小一档。
      lines.push('    <td align="center">')
      lines.push(
        card.url
          ? `      <a href="${escapeHtml(card.url)}"><img src="${escapeHtml(card.avatar)}" width="72" height="72" alt="${name}" title="${title}" /></a>`
          : `      <img src="${escapeHtml(card.avatar)}" width="72" height="72" alt="${name}" title="${title}" />`,
      )
      lines.push('      <br />')
      lines.push(`      <sub><b>${name}</b></sub>`)
      if (note) {
        lines.push('      <br />')
        lines.push(`      <sub>${note}</sub>`)
      }
      lines.push('    </td>')
    }
    lines.push('  </tr>')
  }
  lines.push('</table>')
  lines.push('')

  const rest = hidden > 0 ? `（这里显示前 ${shown.length} 位，其余不单独列出）` : ''
  const bots = cards.filter((card) => card.bot).length
  const mix = bots > 0 ? `（含 ${bots} 个机器人）` : ''
  const graph = repo ? ` · 完整名单见 [graphs/contributors](https://github.com/${repo}/graphs/contributors)` : ''
  lines.push(`共 **${cards.length}** 位贡献者${mix}${rest}${graph}。`)
  return lines.join('\n')
}

/**
 * 把块换进 README。返回新全文；标记缺失直接抛错（宁可失败，也不要悄悄吃掉标记）。
 * 换行符跟着文件走：CRLF 文件写回去还是 CRLF，避免整篇 diff。
 */
export function replaceBlock(readme, block) {
  const start = readme.indexOf(START_MARKER)
  if (start < 0) throw new Error(`README 里找不到起始标记：${START_MARKER}`)
  const end = readme.indexOf(END_MARKER, start + START_MARKER.length)
  if (end < 0) throw new Error(`README 里找不到结束标记：${END_MARKER}`)

  const eol = readme.includes('\r\n') ? '\r\n' : '\n'
  const head = readme.slice(0, start + START_MARKER.length)
  const tail = readme.slice(end)
  const body = block.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n').join(eol)
  return `${head}${eol}${body}${eol}${tail}`
}

const API = 'https://api.github.com'

/** 翻页取全部贡献者；204（空仓库）也不当错误。 */
export async function fetchContributors({ repo, token, fetchImpl = fetch, api = API, maxPages = 10 }) {
  const collected = []
  for (let page = 1; page <= maxPages; page += 1) {
    const url = `${api}/repos/${repo}/contributors?per_page=100&page=${page}`
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-contributors-wall' }
    if (token) headers.authorization = `Bearer ${token}`
    const response = await fetchImpl(url, { headers })
    if (response.status === 204) break
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`GitHub API ${response.status} ${response.statusText}：${url}${detail ? `\n${detail.slice(0, 400)}` : ''}`)
    }
    const batch = await response.json()
    if (!Array.isArray(batch) || batch.length === 0) break
    collected.push(...batch)
    const link = response.headers.get('link') ?? ''
    if (!/rel="next"/.test(link)) break
  }
  return collected
}

function repoFromGit() {
  try {
    return parseRepo(execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }))
  } catch {
    throw new Error('拿不到仓库名：既没有 --repo / GITHUB_REPOSITORY，也没有可用的 origin remote')
  }
}

async function loadCredits(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(`读不到 ${path}（${error.code ?? error.message}）。名单必须留在仓库里，历史被 rebase 掉的人才不会丢。`)
  }
  try {
    return normalizeCredits(JSON.parse(text))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${path} 不是合法 JSON：${error.message}`)
    throw error
  }
}

function parseArgs(argv) {
  const options = {
    check: false,
    print: false,
    repo: undefined,
    readme: 'README.md',
    credits: 'contributors.json',
    limit: 24,
    perRow: 6,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const take = () => {
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`${arg} 后面要跟一个值`)
      i += 1
      return value
    }
    if (arg === '--check') options.check = true
    else if (arg === '--print') options.print = true
    else if (arg === '--repo') options.repo = take()
    else if (arg === '--readme') options.readme = take()
    else if (arg === '--credits') options.credits = take()
    else if (arg === '--limit') options.limit = Number(take())
    else if (arg === '--per-row') options.perRow = Number(take())
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

const HELP = `用法：node scripts/contributors.mjs [选项]

  --check        只检查 README 里的墙是否过期，过期退出码 1（不写文件）
  --print        只打印生成的块，不写文件
  --repo o/n     指定仓库（默认 GITHUB_REPOSITORY → contributors.json 的 repo → origin remote）
  --readme PATH  目标文件（默认 README.md）
  --credits PATH 名单（默认 contributors.json）
  --limit N      最多显示多少人（默认 24）
  --per-row N    每行几个图标（默认 6）
  -h, --help     显示这段

名单在 contributors.json：repo 是 owner/name，people[] 里 name 必填，login / url / avatar / note / maintainer 选填。
maintainer: true 的人永远排最前（副标题写「维护者」），其余按声明顺序，API 发现的新人补在后面。
带 login 的人自动从 GitHub API 取提交数；没有账号的人（上游作者、历史被 rebase 掉的人）
只显示 note。API 里出现但没声明的新人会追加在后面。
需要 GITHUB_TOKEN（或 GH_TOKEN）来避开匿名限流。`

async function main(argv) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(HELP)
    return
  }

  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
  const raw = await readFile(options.readme, 'utf8')

  // 仓库优先级：--repo > Actions 的 GITHUB_REPOSITORY > contributors.json 的 repo > origin remote。
  // 第二项排在声明前面，是因为 CI 里 GITHUB_REPOSITORY 就是这次部署真正统计的那个仓库（fork 出去也不会串）。
  const credits = await loadCredits(options.credits)
  const repo = options.repo ?? process.env.GITHUB_REPOSITORY ?? credits.repo ?? repoFromGit()
  const discovered = normalize(await fetchContributors({ repo, token }))
  const cards = buildCards(credits.people, discovered, { onWarn: (message) => console.error(`contributors: ${message}`) })
  const block = renderWall(cards, { repo, limit: options.limit, perRow: options.perRow })

  if (options.print) {
    console.log(block)
    return
  }

  const next = replaceBlock(raw, block)
  if (options.check) {
    if (next === raw) {
      console.log(`贡献者墙是最新的（${repo}，${cards.length} 位贡献者）`)
      return
    }
    console.error(`README 的贡献者墙已过期（${repo}）。跑 \`node scripts/contributors.mjs\` 重新生成并一起提交。`)
    process.exitCode = 1
    return
  }

  if (next === raw) {
    console.log(`贡献者墙无变化（${repo}，${cards.length} 位贡献者）`)
    return
  }

  await writeFile(options.readme, next, 'utf8')
  console.log(`已更新 ${options.readme}：${repo}，${cards.length} 位贡献者`)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`contributors: ${error.message}`)
    process.exitCode = 1
  })
}
