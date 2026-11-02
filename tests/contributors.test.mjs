/** 贡献者墙：只测纯函数，不碰网络（CI 里那次真正的抓取由 workflow 覆盖）。 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  END_MARKER,
  START_MARKER,
  buildCards,
  identicon,
  normalize,
  normalizeCredits,
  parseRepo,
  renderWall,
  replaceBlock,
} from '../scripts/contributors.mjs'

const humans = [
  { login: 'hxh230802', contributions: 53, type: 'User' },
  { login: 'guguthecoder', contributions: 5, type: 'User' },
  { login: 'Linjiangxian0203', contributions: 1, type: 'User' },
  { login: '912D', contributions: 1, type: 'User' },
]

// 真实的一条：CI 重建 lib 之后，github-actions[bot] 也进了 contributors 列表。
const bot = {
  login: 'github-actions[bot]',
  contributions: 1,
  type: 'Bot',
  avatar_url: 'https://avatars.githubusercontent.com/in/15368?v=4',
  html_url: 'https://github.com/apps/github-actions',
}

const discovered = normalize(humans)
const withBot = normalize([...humans, bot])

const declared = {
  repo: 'hxh230802/dsh-superagent-prototype',
  people: [
    { name: 'hxh230802', login: 'hxh230802' },
    { name: 'guguthecoder', login: 'guguthecoder' },
    { name: '912D', login: '912D' },
    { name: 'Linjiangxian0203', login: 'Linjiangxian0203' },
  ],
}

describe('contributors: repo 解析', () => {
  it('认得出 ssh 与 https 写的 remote', () => {
    assert.equal(parseRepo('git@github.com:hxh230802/dsh-superagent-prototype.git'), 'hxh230802/dsh-superagent-prototype')
    assert.equal(parseRepo('https://github.com/hxh230802/dsh-superagent-prototype.git'), 'hxh230802/dsh-superagent-prototype')
    assert.equal(parseRepo('https://token@github.com/o/n'), 'o/n')
    assert.equal(parseRepo('ssh://git@github.com/o/n.git\n'), 'o/n')
  })

  it('解析不了就报错，而不是猜一个仓库', () => {
    assert.throws(() => parseRepo('/some/local/path'), /无法从 remote 解析/)
  })
})

describe('contributors: 名单清洗', () => {
  it('合并大小写重复、按提交数倒序', () => {
    const list = normalize([
      { login: 'alice', contributions: 3, type: 'User' },
      { login: 'Bob', contributions: 5, type: 'User' },
      { login: 'bob', contributions: 2, type: 'User' },
    ])
    assert.deepEqual(
      list.map((person) => [person.login, person.contributions]),
      [
        ['Bob', 7],
        ['alice', 3],
      ],
    )
  })

  it('机器人留下，并打上 bot 标记', () => {
    const entry = normalize([bot])[0]
    assert.equal(entry.login, 'github-actions[bot]')
    assert.equal(entry.bot, true)
    assert.equal(entry.url, 'https://github.com/apps/github-actions')
    assert.equal(entry.avatar, 'https://avatars.githubusercontent.com/in/15368?v=4')
  })

  it('匿名贡献者跳过，没有主页可链', () => {
    assert.equal(normalize([{ name: 'Anonymous Team', contributions: 100 }]).length, 0)
  })
})

describe('contributors: 名单文件', () => {
  it('带出 repo 与人，repo 决定去哪个仓库取数', () => {
    const credits = normalizeCredits(declared)
    assert.equal(credits.repo, 'hxh230802/dsh-superagent-prototype')
    assert.deepEqual(
      credits.people.map((person) => person.login),
      ['hxh230802', 'guguthecoder', '912D', 'Linjiangxian0203'],
    )
  })

  it('people 可以缺省，repo 可以缺省', () => {
    const credits = normalizeCredits({})
    assert.equal(credits.repo, undefined)
    assert.deepEqual(credits.people, [])
  })

  it('字段写错就报错，不静默丢人', () => {
    assert.throws(() => normalizeCredits({ people: 'x' }), /people 数组/)
    assert.throws(() => normalizeCredits({ people: [{ login: 'x' }] }), /缺 name/)
    assert.throws(() => normalizeCredits({ people: [{ name: 'a', login: 'has space' }] }), /不是合法 GitHub 用户名/)
    assert.throws(() => normalizeCredits({ people: [{ name: 'a', url: 'ftp://x' }] }), /必须是 http\(s\) 地址/)
    assert.throws(() => normalizeCredits({ repo: 'not-a-repo' }), /不是 owner\/name/)
  })
})

describe('contributors: 声明 + 发现 合并', () => {
  it('仓库里四个人都在，按声明的顺序，提交数来自 API', () => {
    const cards = buildCards(normalizeCredits(declared).people, discovered)
    assert.deepEqual(
      cards.map((card) => [card.name, card.note]),
      [
        ['hxh230802', '53 次提交'],
        ['guguthecoder', '5 次提交'],
        ['912D', '1 次提交'],
        ['Linjiangxian0203', '1 次提交'],
      ],
    )
  })

  it('机器人排在人后面，副标题写明是机器人', () => {
    const cards = buildCards(normalizeCredits(declared).people, withBot)
    assert.equal(cards.length, 5)
    assert.deepEqual(cards.at(-1), {
      name: 'github-actions[bot]',
      url: 'https://github.com/apps/github-actions',
      avatar: 'https://avatars.githubusercontent.com/in/15368?v=4',
      note: '1 次提交 · 机器人',
      bot: true,
    })
  })

  it('上游作者不在贡献者里 —— 他只该出现在致谢', () => {
    const cards = buildCards(normalizeCredits(declared).people, withBot)
    assert.equal(
      cards.some((card) => /DeepSeek|Harness Team/.test(card.name)),
      false,
    )
  })

  it('API 里出现、声明里没写的人自动追加', () => {
    const cards = buildCards([{ name: 'hxh230802', login: 'hxh230802' }], discovered)
    assert.deepEqual(
      cards.map((card) => card.name),
      ['hxh230802', 'guguthecoder', '912D', 'Linjiangxian0203'],
    )
  })

  it('没有 GitHub 账号的人不编造链接，头像走 identicon', () => {
    const [card] = buildCards([{ name: 'tacit', note: '早期提交' }], [])
    assert.equal(card.url, undefined)
    assert.equal(card.avatar, identicon('tacit'))
    assert.match(card.avatar, /^https:\/\/github\.com\/identicons\/[0-9a-f]{32}\.png$/)
  })

  it('重复声明同一个人会告警并跳过', () => {
    const warnings = []
    const cards = buildCards(
      [{ name: 'tacit' }, { name: 'TACIT', note: '重复' }],
      [],
      { onWarn: (message) => warnings.push(message) },
    )
    assert.equal(cards.length, 1)
    assert.equal(warnings.length, 1)
  })

  it('声明的 login 在 API 里查不到时仍然显示，只是没有提交数', () => {
    const [card] = buildCards([{ name: 'Moved', login: 'moved' }], [])
    assert.equal(card.note, undefined)
    assert.equal(card.url, 'https://github.com/moved')
  })
})

describe('contributors: 渲染', () => {
  const cards = buildCards(normalizeCredits(declared).people, withBot)

  it('五个图标（四个人 + 一个机器人），一格 72px，图标就是链接', () => {
    const block = renderWall(cards, { repo: 'hxh230802/dsh-superagent-prototype' })
    assert.equal((block.match(/<td /g) ?? []).length, 5)
    assert.equal((block.match(/width="72"/g) ?? []).length, 5, '一格一个 72px 图标')
    assert.equal((block.match(/<a href="https:\/\/github\.com\/apps\/[^"]+"/g) ?? []).length, 1, '机器人链到 /apps/ 而不是个人主页')
    assert.equal(/<a href="https:\/\/github\.com\/hxh230802"><sub>/.test(block), false, '名字不再重复成第二个链接')
  })

  it('总数把机器人算进去，但注明有几个', () => {
    const block = renderWall(cards, { repo: 'hxh230802/dsh-superagent-prototype' })
    assert.match(block, /共 \*\*5\*\* 位贡献者（含 1 个机器人）/)
    assert.match(block, /https:\/\/github\.com\/hxh230802\/dsh-superagent-prototype\/graphs\/contributors/)
  })

  it('没有机器人时不说「含 0 个机器人」', () => {
    const block = renderWall(buildCards(normalizeCredits(declared).people, discovered), { repo: 'o/n' })
    assert.match(block, /共 \*\*4\*\* 位贡献者 · /)
  })

  it('超过 limit 时只说总数，不把长列表铺满 README', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `u${i}`, avatar: identicon(`u${i}`), note: `${i} 次提交` }))
    const block = renderWall(many, { repo: 'o/n', limit: 8, perRow: 4 })
    assert.equal((block.match(/<td /g) ?? []).length, 8)
    assert.match(block, /共 \*\*30\*\* 位贡献者/)
    assert.match(block, /其余不单独列出/)
  })

  it('空名单给一句说明，不渲染空表格', () => {
    const block = renderWall([], { repo: 'o/n' })
    assert.match(block, /还没有贡献者记录/)
    assert.equal(block.includes('<table>'), false)
  })
})

describe('contributors: 只改标记之间的内容', () => {
  const readme = `# t\r\n\r\ntext\r\n${START_MARKER}\r\nold\r\n${END_MARKER}\r\n\r\ntail\r\n`

  it('保留 CRLF 和标记之外的字节', () => {
    const next = replaceBlock(readme, 'new\nlines')
    assert.equal(next, `# t\r\n\r\ntext\r\n${START_MARKER}\r\nnew\r\nlines\r\n${END_MARKER}\r\n\r\ntail\r\n`)
  })

  it('幂等：同样的块写两次结果一样', () => {
    const once = replaceBlock(readme, 'new\nlines')
    assert.equal(replaceBlock(once, 'new\nlines'), once)
  })

  it('标记缺了就报错，不静默吞掉', () => {
    assert.throws(() => replaceBlock('# t\n', 'x'), /找不到起始标记/)
    assert.throws(() => replaceBlock(`# t\n${START_MARKER}\nx\n`, 'x'), /找不到结束标记/)
  })
})
