// 作品库列表纯逻辑单测：同题分组（身份=稳定 task.id，不按标题猜）+ 追加去重（客户端兜底层）
import { describe, expect, it } from 'vitest'
import {
  buildUnits,
  dedupeBySlug,
  groupByTask,
  groupRepresentative,
  groupScalar,
  isFoldableGroup,
  primaryTask,
  type GroupableDemo,
  type GroupSortableDemo,
} from '../src/utils/demoList'

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

// ---------------------------------------------------------------- 作品库单元（demo 组）

type TaskRef = { id: number; slug: string; title: string }
/** 单元排序要用的作品（带时间/热度/评分） */
function s(slug: string, tasks?: TaskRef[], extra: Partial<GroupSortableDemo> = {}): GroupSortableDemo {
  return { slug, tasks, ...extra }
}

describe('buildUnits：组=堆叠卡，占一个格子', () => {
  it('多件同题 → 一个 group 单元；单件组与未挂题作品 → 普通 demo 单元', () => {
    const units = buildUnits([s('1', [T1]), s('2', [T1]), s('3', [T2]), s('u')])
    expect(units.map((u) => u.kind)).toEqual(['group', 'demo', 'demo'])
    expect(units[0].key).toBe('g:11')
    expect(units[1].key).toBe('d:3')
    expect(units[2].key).toBe('d:u')
  })

  it('组在它第一件作品出现的位置产出，组内作品不再单独成卡', () => {
    const units = buildUnits([s('a', [T1]), s('b'), s('c', [T1])])
    expect(units.map((u) => u.key)).toEqual(['g:11', 'd:b'])
  })

  it('最新：组的时间口径 = 组内最近更新的那一件', () => {
    const items = [
      s('a', [T1], { created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' }),
      s('b', [T1], { created_at: '2026-01-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' }),
      s('c', undefined, { created_at: '2026-05-01T00:00:00Z', updated_at: '2026-05-01T00:00:00Z' }),
    ]
    expect(buildUnits(items, { sort: 'newest' }).map((u) => u.key)).toEqual(['g:11', 'd:c'])
  })

  it('最热：组的热度口径 = 组内浏览最多的那一件', () => {
    const items = [
      s('a', [T1], { view_count: 3 }),
      s('b', [T1], { view_count: 900 }),
      s('c', undefined, { view_count: 100 }),
    ]
    expect(buildUnits(items, { sort: 'popular' }).map((u) => u.key)).toEqual(['g:11', 'd:c'])
  })

  it('评分：组的评分口径 = 组内最高分；零票作品排在所有有票作品之后', () => {
    const items = [
      s('a', [T1], { rating_avg: 4.9, rating_count: 5 }),
      s('b', [T1], { rating_avg: 2.0, rating_count: 9 }),
      s('c', undefined, { rating_avg: 4.2, rating_count: 7 }),
      s('z', undefined, { rating_avg: 0, rating_count: 0 }),
    ]
    expect(buildUnits(items, { sort: 'rating' }).map((u) => u.key)).toEqual(['g:11', 'd:c', 'd:z'])
  })

  it('random / prompt 模式不重排：服务端顺序原样保留', () => {
    const items = [
      s('a', undefined, { view_count: 1 }),
      s('b', [T1], { view_count: 900 }),
      s('c', [T1], { view_count: 900 }),
    ]
    expect(buildUnits(items, { sort: 'none' }).map((u) => u.key)).toEqual(['d:a', 'g:11'])
    expect(buildUnits(items).map((u) => u.key)).toEqual(['d:a', 'g:11'])
  })

  it('代表件 = 组内最好的一件，且组内展示序把它放在第一位', () => {
    const items = [
      s('old', [T1], { updated_at: '2026-01-01T00:00:00Z' }),
      s('new', [T1], { updated_at: '2026-09-01T00:00:00Z' }),
    ]
    const g = buildUnits(items, { sort: 'newest' })[0]
    if (g.kind !== 'group') throw new Error('这里应当是一个组单元')
    expect(g.rep.slug).toBe('new')
    expect(g.group.items.map((x) => x.slug)).toEqual(['new', 'old'])
    expect(groupRepresentative(items, 'newest').slug).toBe('new')
  })

  it('groupScalar 逐项取最大；空组返回 [0, 0]', () => {
    expect(groupScalar([{ slug: 'a', view_count: 2 }, { slug: 'b', view_count: 9 }], 'popular')).toEqual([9, 0])
    expect(groupScalar([], 'popular')).toEqual([0, 0])
  })

  it('排序稳定：同值单元按原出现序', () => {
    const items = [
      s('a', undefined, { view_count: 5 }),
      s('b', [T1], { view_count: 5 }),
      s('c', [T1], { view_count: 5 }),
      s('d', undefined, { view_count: 5 }),
    ]
    expect(buildUnits(items, { sort: 'popular' }).map((u) => u.key)).toEqual(['d:a', 'g:11', 'd:d'])
  })
})
