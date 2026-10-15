// 作品库列表纯逻辑单测：同题分组（身份=稳定 task.id，不按标题猜）+ 追加去重（客户端兜底层）
import { describe, expect, it } from 'vitest'
import { dedupeBySlug, groupByTask, isFoldableGroup, primaryTask, type GroupableDemo } from '../src/utils/demoList'

type D = GroupableDemo & { title?: string }

function d(slug: string, tasks?: { id: number; slug: string; title: string }[]): D {
  return { slug, tasks }
}
const T1 = { id: 11, slug: 'task-a', title: '题目A' }
const T2 = { id: 22, slug: 'task-b', title: '题目B' }

describe('primaryTask', () => {
  it('无挂题返回 null（这类作品归入未挂题组）', () => {
    expect(primaryTask(d('x'))).toBeNull()
    expect(primaryTask(d('x', []))).toBeNull()
  })
  it('多题挂载默认取 id 最小者：与后端返回顺序无关，结果稳定', () => {
    expect(primaryTask(d('x', [T2, T1]))?.id).toBe(11)
    expect(primaryTask(d('x', [T1, T2]))?.id).toBe(11)
  })
  it('当前筛选题目优先（preferTaskSlug）：筛选语义与分组归属一致', () => {
    expect(primaryTask(d('x', [T1, T2]), 'task-b')?.id).toBe(22)
    // 作品没挂筛选题 → 回落最小 id，不会凭空造组
    expect(primaryTask(d('x', [T1, T2]), 'task-zzz')?.id).toBe(11)
  })
})

describe('groupByTask', () => {
  it('同题作品归入同组（组身份=task.id），组内保持原顺序', () => {
    const groups = groupByTask([d('1', [T1]), d('2', [T1]), d('3', [T1])])
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe(11)
    expect(groups[0].task?.slug).toBe('task-a')
    expect(groups[0].items.map((x) => x.slug)).toEqual(['1', '2', '3'])
  })
  it('组序 = 各组首件在原列表中的位次（保留当前排序语义，分组只是呈现层）', () => {
    const groups = groupByTask([d('1', [T2]), d('2', [T1]), d('3', [T2]), d('4', [T1])])
    expect(groups.map((g) => g.key)).toEqual([22, 11])
  })
  it('preferTaskSlug 时多题作品归入筛选题组', () => {
    const groups = groupByTask([d('1', [T1, T2])], 'task-b')
    expect(groups.map((g) => g.key)).toEqual([22])
  })
  it('未挂题作品恒归入末尾一个 key=null 的组，不与题组混杂', () => {
    const groups = groupByTask([d('u1'), d('2', [T1]), d('u2')])
    expect(groups.map((g) => g.key)).toEqual([11, null])
    expect(groups[1].items.map((x) => x.slug)).toEqual(['u1', 'u2'])
  })
  it('空列表返回空组数组', () => {
    expect(groupByTask([])).toEqual([])
  })
  it('tasks 缺失（undefined）与空数组同等对待', () => {
    const groups = groupByTask([{ slug: 'a' } as D, d('b', [])])
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBeNull()
  })
})

describe('isFoldableGroup', () => {
  it('只有真题组且多于一件才折叠；单件组与未挂题组不折叠', () => {
    const [multi, single, ungrouped] = groupByTask([d('1', [T1]), d('2', [T1]), d('3', [T2]), d('u')])
    expect(isFoldableGroup(multi)).toBe(true)
    expect(isFoldableGroup(single)).toBe(false)
    expect(isFoldableGroup(ungrouped)).toBe(false)
  })
})

describe('dedupeBySlug', () => {
  it('重复 slug 不再追加，保留首次出现（兜底层；顺序稳定性根修在后端会话种子 rs）', () => {
    const existing = [d('a'), d('b')]
    const { items, added } = dedupeBySlug(existing, [d('c'), d('b'), d('d')])
    expect(items.map((x) => x.slug)).toEqual(['a', 'b', 'c', 'd'])
    expect(added).toBe(2)
  })
  it('整页全是重复：列表原样保留（不产生空数组替换），added=0', () => {
    const existing = [d('a'), d('b')]
    const { items, added } = dedupeBySlug(existing, [d('b'), d('a')])
    expect(items.map((x) => x.slug)).toEqual(['a', 'b'])
    expect(added).toBe(0)
  })
  it('不改动入参数组（纯函数）', () => {
    const existing = [d('a')]
    const incoming = [d('b')]
    dedupeBySlug(existing, incoming)
    expect(existing).toHaveLength(1)
    expect(incoming).toHaveLength(1)
  })
})
