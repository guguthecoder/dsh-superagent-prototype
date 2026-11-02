/**
 * 补丁一（接入）的工具层测试：一切皆节点，一切皆信号。
 *
 *   node --test tests/msp-act.test.ts
 *
 * 这里不需要真的起一个 MSP 网格：`setMspMesh` 收的就是接口，用假的网格验「Agent 能不能
 * 看见节点、能不能发信号、能不能调工具」这三件事——它们正是「接不上的就永远看不见」的反面。
 */
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { mspMesh, peerCapabilities, registerMspActTools, setMspMesh } from '../src/sources/msp-act.ts'

function fakeRegistry() {
  const defs = new Map<string, any>()
  const tools = {
    register(def: any) {
      defs.set(def.name, def)
      return () => { defs.delete(def.name) }
    },
  }
  return { tools, defs, call: (name: string, args?: unknown) => defs.get(name)!.execute(args) }
}

const registry = fakeRegistry()
const disposers = registerMspActTools(registry.tools)

afterEach(() => { setMspMesh(null) })

function mesh(overrides: Record<string, unknown> = {}) {
  const published: { path: string; payload: Record<string, unknown> }[] = []
  const calls: { peer: string; tool: string; args?: Record<string, unknown> }[] = []
  const current = {
    nodeId: 'superagent',
    publish: (path: string, payload: Record<string, unknown>) => { published.push({ path, payload }) },
    neighbors: () => ['file-watcher', 'clipboard'],
    connections: () => ['file-watcher'],
    peerManifest: (id: string) => (id === 'file-watcher'
      ? { signals: [{ path: 'file.created' }], tools: [{ name: 'hash', description: '算哈希' }] }
      : {}),
    call: async (peer: string, tool: string, args?: Record<string, unknown>) => {
      calls.push({ peer, tool, args })
      return { content: [{ type: 'text', text: 'sha256:abc' }] }
    },
    ...overrides,
  }
  setMspMesh(current as any)
  return { current, published, calls }
}

describe('注册', () => {
  it('三个工具都挂上了', () => {
    assert.deepEqual([...registry.defs.keys()].sort(), ['msp_call', 'msp_nodes', 'msp_publish'])
    assert.equal(disposers.length, 3)
  })
})

describe('网格没起来时', () => {
  it('三个工具都说人话，而不是抛错', async () => {
    setMspMesh(null)
    assert.equal(mspMesh(), null)
    for (const name of ['msp_nodes', 'msp_publish', 'msp_call']) {
      const result = await registry.call(name, { path: 'x.y', peer: 'p', tool: 't' })
      assert.equal(result.structuredContent.ok, false)
      assert.match(result.structuredContent.message, /MSP 节点还没起来/)
    }
  })
})

describe('msp_nodes：看见谁', () => {
  it('列出邻居和各自声明的能力', async () => {
    mesh()
    const result = await registry.call('msp_nodes', {})
    assert.equal(result.structuredContent.ok, true)
    assert.deepEqual(result.structuredContent.peers.map((peer: any) => peer.id), ['clipboard', 'file-watcher'])
    const watcher = result.structuredContent.peers.find((peer: any) => peer.id === 'file-watcher')
    assert.deepEqual(watcher.signals, ['file.created'])
    assert.deepEqual(watcher.tools.map((tool: any) => tool.name), ['hash'])
    assert.match(result.structuredContent.text, /本节点：superagent/)
  })

  it('一个邻居都没有时，明确说「在线但没人」', async () => {
    mesh({ neighbors: () => [], connections: () => [] })
    const result = await registry.call('msp_nodes', {})
    assert.match(result.structuredContent.text, /暂时没有连上的邻居/)
    assert.deepEqual(peerCapabilities(), [])
  })
})

describe('msp_publish：一切皆信号', () => {
  it('动作不需要为设备特判：路径 + 载荷就够', async () => {
    const { published } = mesh()
    const result = await registry.call('msp_publish', { path: 'device.light.on', payload: { room: 'kitchen' } })
    assert.equal(result.structuredContent.ok, true)
    assert.equal(published.length, 1)
    assert.equal(published[0]?.path, 'device.light.on')
    assert.equal(published[0]?.payload.room, 'kitchen')
    assert.equal(published[0]?.payload.published_by, 'superagent', '发出去的信号要能被追溯来源')
    assert.equal(typeof published[0]?.payload.published_at, 'string')
  })

  it('路径不合法就拒绝，别把脏路径发进网格', async () => {
    const { published } = mesh()
    const result = await registry.call('msp_publish', { path: 'device light on!' })
    assert.equal(result.structuredContent.ok, false)
    assert.equal(published.length, 0)
  })

  it('发送抛错时降级成可读消息', async () => {
    mesh({ publish: () => { throw new Error('socket closed') } })
    const result = await registry.call('msp_publish', { path: 'a.b' })
    assert.equal(result.structuredContent.ok, false)
    assert.match(result.structuredContent.message, /发送失败/)
  })
})

describe('msp_call：请求/响应', () => {
  it('只允许调对方清单里声明过的工具', async () => {
    const { calls } = mesh()
    const denied = await registry.call('msp_call', { peer: 'file-watcher', tool: 'rm-rf' })
    assert.equal(denied.structuredContent.ok, false)
    assert.match(denied.structuredContent.message, /没有声明工具 rm-rf/)
    assert.equal(calls.length, 0)

    const unknownPeer = await registry.call('msp_call', { peer: 'ghost', tool: 'hash' })
    assert.equal(unknownPeer.structuredContent.ok, false)
    assert.match(unknownPeer.structuredContent.message, /没有连上节点 ghost/)
  })

  it('调通了就拿回结果', async () => {
    const { calls } = mesh()
    const result = await registry.call('msp_call', { peer: 'file-watcher', tool: 'hash', args: { path: 'a.zip' } })
    assert.equal(result.structuredContent.ok, true)
    assert.match(result.structuredContent.text, /sha256:abc/)
    assert.deepEqual(calls, [{ peer: 'file-watcher', tool: 'hash', args: { path: 'a.zip' } }])
  })

  it('对端没实现 call 时，明确说只能发信号', async () => {
    mesh({ call: undefined })
    const result = await registry.call('msp_call', { peer: 'file-watcher', tool: 'hash' })
    assert.equal(result.structuredContent.ok, false)
    assert.match(result.structuredContent.message, /只能用 msp_publish/)
  })
})
