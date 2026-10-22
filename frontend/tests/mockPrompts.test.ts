import { describe, expect, it } from 'vitest'
import { createMockPromptStore } from '../src/api/mockPrompts'
import type { DemoSummary, SuggestionItem } from '../src/api/types'

function fixture() {
  const demos: DemoSummary[] = []
  const suggestions: SuggestionItem[] = []
  let user: number | null = 1, seq = 0
  const store = createMockPromptStore({ demos: () => demos, suggestions, userId: () => user, nextSuggestionId: () => ++seq })
  return { demos, suggestions, store, login: (id: number | null) => { user = id } }
}
function demo(slug: string, prompt: string, status = 'approved'): DemoSummary {
  return { slug, prompt, title: slug, status, description: '', cover_url: '', author: 'tester', author_id: 1,
    tags: [], view_count: 0, download_count: 0, comment_count: 0, created_at: '2026-10-23T00:00:00Z' }
}

describe('提示词离线演示契约', () => {
  it('无作品的外部提示词通过审核后才公开', () => {
    const f = fixture(); const result = f.store.propose({ title: '外部提示词', content: 'Make a clock' })
    expect(result.status).toBe('pending'); expect(f.store.list().total).toBe(0)
    const id = f.store.approve(f.suggestions[0]); f.suggestions[0].status = 'approved'
    expect(f.store.get(id)).toMatchObject({ content: 'Make a clock', demos_total: 0, models_total: 0, source: 'contributed' })
    expect(f.store.demos(id).total).toBe(0)
  })
  it('正文规范化只处理CRLF和首尾，不合并大小写与内部空格', () => {
    const f = fixture()
    f.demos.push(demo('a', 'Make\r\nA clock '), demo('b', ' Make\nA clock'), demo('c', 'make\nA clock'), demo('d', 'Make\nA  clock'))
    expect(f.store.list().total).toBe(3)
    expect(f.store.list().items.find((p) => p.content === 'Make\nA clock')?.demos_total).toBe(2)
  })
  it('私有和未审核作品不进入公开计数或详情', () => {
    const f = fixture(); f.demos.push(demo('a', 'secret', 'pending'), demo('b', 'hidden', 'rejected'))
    expect(f.store.list().total).toBe(0); expect(() => f.store.get(1)).toThrow()
  })
  it('同作者待审投稿幂等，公开后相同正文返回已有入口', () => {
    const f = fixture(); const body = { title: '时钟', content: 'clock' }
    const a = f.store.propose(body), b = f.store.propose({ ...body, title: '换了标题' })
    expect(a).toEqual(b); expect(f.suggestions).toHaveLength(1)
    f.store.approve(f.suggestions[0]); f.suggestions[0].status = 'approved'
    expect(f.store.propose(body)).toMatchObject({ status: 'existing' })
  })
  it('去重按作者隔离，后一次审核保留已有元数据', () => {
    const f = fixture(); f.store.propose({ title: '先投稿', content: 'clock' }); f.login(2)
    f.store.propose({ title: '后投稿', content: 'clock' }); expect(f.suggestions).toHaveLength(2)
    const id = f.store.approve(f.suggestions[0]); f.store.approve(f.suggestions[1])
    expect(f.store.get(id).title).toBe('先投稿')
  })
  it('分页总数同源，按结果数量排序，按有无结果筛选', () => {
    const f = fixture(); f.demos.push(demo('a', 'x'), demo('b', 'x'), demo('c', 'y'))
    f.store.propose({ title: '未测试', content: 'z' }); f.store.approve(f.suggestions[0])
    expect(f.store.list({ sort: 'most_tested', page_size: 1 })).toMatchObject({ total: 3, items: [{ content: 'x', demos_total: 2 }] })
    expect(f.store.list({ has_results: false }).items.map((p) => p.content)).toEqual(['z'])
    expect(f.store.list({ q: '未测试' }).total).toBe(1)
  })
  it('拒绝匿名、空白、过长正文及危险来源协议', () => {
    const f = fixture(); const good = { title: 'test', content: 'body' }
    f.login(null); expect(() => f.store.propose(good)).toThrow(); f.login(1)
    expect(() => f.store.propose({ ...good, content: '   ' })).toThrow()
    expect(() => f.store.propose({ ...good, content: 'a'.repeat(20001) })).toThrow()
    expect(() => f.store.propose({ ...good, source_url: 'javascript:alert(1)' })).toThrow()
    expect(() => f.store.propose({ ...good, source_url: 'https://name:password@example.com/prompt' })).toThrow()
    expect(() => f.store.propose({ ...good, source_url: 'https://example.com/prompt\npart' })).toThrow()
    expect(f.suggestions).toHaveLength(0)
  })
})
