import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerExperienceTools } from '../src/sources/experience-tools.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'experiences-'))
  process.env.TACIT_EXPERIENCE_DIR = dir
})
afterEach(() => {
  delete process.env.TACIT_EXPERIENCE_DIR
  rmSync(dir, { recursive: true, force: true })
})

type Tool = { execute: (args: unknown) => Promise<{ structuredContent: { ok: boolean; message: string } }> }
function tools(): Record<string, Tool> {
  const registrations: { name: string }[] = []
  registerExperienceTools({ register: (definition: unknown) => { registrations.push(definition as { name: string }); return definition } })
  return Object.fromEntries(registrations.map(definition => [definition.name, definition])) as never
}
/** The registry is keyed by tool name, so a lookup is `Tool | undefined` under `noUncheckedIndexedAccess`; a missing name is a broken fixture, not a case to assert on. */
const tool = (name: string): Tool => {
  const found = tools()[name]
  if (!found) throw new Error(`tool ${name} is not registered`)
  return found
}

describe('experience trust levels', () => {
  it('creates an experience at L3 and says so when the model asks for L2', async () => {
    const created = await tool('experience_create').execute({ id: 'move', trigger: 'file.created', action: '移动文件', trust_level: 'L2' })
    expect(readFileSync(join(dir, 'move.md'), 'utf8')).toContain('trust_level: L3')
    expect(created.structuredContent.message).toContain('L3')
  })

  it('refuses to lower a level and reports it instead of claiming success', async () => {
    await tool('experience_create').execute({ id: 'move', trigger: 'file.created', action: '移动文件' })
    const updated = await tool('experience_update').execute({ id: 'move', trust_level: 'L2' })
    expect(updated.structuredContent.ok).toBe(false)
    expect(updated.structuredContent.message).toContain('L3')
    expect(readFileSync(join(dir, 'move.md'), 'utf8')).toContain('trust_level: L3')
  })

  it('still updates the other fields of a refused downgrade', async () => {
    const created = await tool('experience_create').execute({ id: 'move', trigger: 'file.created', action: '移动文件' })
    expect(created.structuredContent.ok).toBe(true)
    await tool('experience_update').execute({ id: 'move', action: '移动到目标目录', trust_level: 'L2' })
    const text = readFileSync(join(dir, 'move.md'), 'utf8')
    expect(text).toContain('action: 移动到目标目录')
    expect(text).toContain('trust_level: L3')
  })
})
