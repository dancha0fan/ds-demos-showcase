/**
 * 作品库列表的两个纯逻辑件（零 DOM，可单测）：
 *
 * ① 同题分组（demoList.groupByTask）：作品库「按题折叠」的数据层。
 *    分组身份 = 题目的稳定 **task.id**（序列化器已随列表返回 demo.tasks），
 *    **绝不按标题文本猜同题**——标题相似的两道题就是两组。
 *    一件作品挂多题时（demo_tasks 多对多）按确定策略单归属，避免同一作品在库里出现多次：
 *    优先归入「当前筛选题目」（URL ?task= 的 slug），否则归入 id 最小的题目。
 * ② 追加去重（demoList.dedupeBySlug）：random 翻页的顺序稳定性由后端会话固定种子（rs）
 *    根修（跨时间桶不重复不漏件）；这层去重只作客户端兜底（如缓存/竞态造成的重复），
 *    **不是漏项的解法**——漏项必须靠顺序本身稳定。
 */

/** 分组所需的最小作品形状（DemoSummary 的超集兼容子集） */
export interface GroupableDemo {
  slug: string
  tasks?: { id: number; slug: string; title: string }[] | null
}

export interface TaskGroup<T extends GroupableDemo> {
  /** 组身份 = 主题目 id（稳定、不可变）；未挂题组为 null */
  key: number | null
  /** 组代表题目；未挂题组为 null */
  task: { id: number; slug: string; title: string } | null
  items: T[]
}

/**
 * 一件作品的归属题目（单归属，确定展示策略）：
 * - preferTaskSlug（当前筛选题目）：作品挂了它就优先归它 —— 筛选语义与分组语义一致；
 * - 否则取 **id 最小** 的题目：与后端返回顺序无关，跨请求/跨页稳定（id 不可变）。
 */
export function primaryTask<T extends GroupableDemo>(
  demo: T,
  preferTaskSlug?: string,
): { id: number; slug: string; title: string } | null {
  const list = demo.tasks ?? []
  if (!list.length) return null
  if (preferTaskSlug) {
    const preferred = list.find((t) => t.slug === preferTaskSlug)
    if (preferred) return preferred
  }
  let best = list[0]
  for (const t of list) if (t.id < best.id) best = t
  return best
}

/**
 * 同题分组：
 * - 组序 = 各组首件在原列表中的位次 → 当前排序（最新/最热/随机）的语义原样保留，分组只是呈现层；
 * - 组内保持原列表顺序；
 * - 未挂题的作品恒归入末尾一个不折叠的「未挂题」组（它们没有题可依）。
 *
 * 注意：分组作用于**已加载切片**（服务端分页不变），组内 items.length 是已加载数，
 * 不是该题的真实总数 —— 展示层必须标注「已加载」（见 DemosView 组头）。
 */
export function groupByTask<T extends GroupableDemo>(
  items: readonly T[],
  preferTaskSlug?: string,
): TaskGroup<T>[] {
  const byId = new Map<number, TaskGroup<T>>()
  const ungrouped: T[] = []
  for (const d of items) {
    const task = primaryTask(d, preferTaskSlug)
    if (!task) {
      ungrouped.push(d)
      continue
    }
    let g = byId.get(task.id)
    if (!g) {
      g = { key: task.id, task, items: [] }
      byId.set(task.id, g)
    }
    g.items.push(d)
  }
  const groups = [...byId.values()]
  if (ungrouped.length) groups.push({ key: null, task: null, items: ungrouped })
  return groups
}

/** 只有「真题组且多于一件」才折叠；单件组与未挂题组原样渲染（折叠 UI 没有意义） */
export function isFoldableGroup<T extends GroupableDemo>(group: TaskGroup<T>): boolean {
  return group.key !== null && group.items.length > 1
}

/**
 * 追加去重（客户端兜底）：保留既有列表中首次出现的 slug，只追加新面孔。
 * 返回新数组（不改动入参），added = 实际新增件数（0 = 整页全是重复，仍照常推进页码）。
 */
export function dedupeBySlug<T extends { slug: string }>(
  existing: readonly T[],
  incoming: readonly T[],
): { items: T[]; added: number } {
  const seen = new Set(existing.map((d) => d.slug))
  const fresh: T[] = []
  for (const d of incoming) {
    if (seen.has(d.slug)) continue
    seen.add(d.slug)
    fresh.push(d)
  }
  return { items: fresh.length ? [...existing, ...fresh] : [...existing], added: fresh.length }
}

// ---------------------------------------------------------------- 作品库单元（demo 组）

/**
 * 作品库的渲染单元：一件作品，或一个同题组（≥2 件，渲染成堆叠卡）。
 *
 * 为什么要「单元」这一层：原先同题组是「整行组头 + 折叠摘要」，会霸占一整行、
 * 打断瀑布流。改成单元后，一个组就是瀑布流里的一个格子（堆叠卡），
 * 单件作品照旧是一张普通卡 —— 两类单元在同一套网格与同一套排序里混排。
 */
export type ListUnit<T extends GroupableDemo> =
  | { kind: 'demo'; demo: T; key: string }
  | { kind: 'group'; group: TaskGroup<T>; rep: T; key: string }

/** 单元排序要用的作品字段（DemoSummary 的兼容子集） */
export interface GroupSortableDemo extends GroupableDemo {
  created_at?: string
  updated_at?: string
  view_count?: number
  rating_avg?: number
  rating_count?: number
}

/** 作品库的排序口径；`none` = 不重排（随机/提示词模式必须原样保留服务端顺序） */
export type UnitSortMode = 'newest' | 'popular' | 'rating' | 'none'

/**
 * 二元排序值（主序, 次序）。用元组而不是拼成一个魔数：
 * 评分同分时按票数排，票数为 0 的一律排在所有有票作品之后（没证据不等于 0 分）。
 */
export type SortTuple = readonly [number, number]

function timeOf(d: GroupSortableDemo): number {
  const t = Date.parse(d.updated_at || d.created_at || '')
  return Number.isFinite(t) ? t : 0
}

/** 单件作品的排序值 */
export function demoScalar(d: GroupSortableDemo, mode: UnitSortMode): SortTuple {
  switch (mode) {
    case 'newest':
      return [timeOf(d), 0]
    case 'popular':
      return [d.view_count ?? 0, 0]
    case 'rating':
      return d.rating_count ? [d.rating_avg ?? 0, d.rating_count] : [-1, 0]
    default:
      return [0, 0]
  }
}

/** 组的排序值 = 组内逐项取最大（时间=最近更新、热度=浏览最多、评分=最高分） */
export function groupScalar(items: readonly GroupSortableDemo[], mode: UnitSortMode): SortTuple {
  let best: SortTuple = [-Infinity, -Infinity]
  for (const d of items) {
    const v = demoScalar(d, mode)
    if (v[0] > best[0] || (v[0] === best[0] && v[1] > best[1])) best = v
  }
  return best[0] === -Infinity ? [0, 0] : best
}

/** 组的代表件（堆叠卡最上面那张）：按当前排序口径取「最好的一件」；无口径时取第一件 */
export function groupRepresentative<T extends GroupSortableDemo>(items: readonly T[], mode: UnitSortMode): T {
  if (mode === 'none' || items.length < 2) return items[0]
  let best = items[0]
  const bestV = demoScalar(best, mode)
  for (const d of items.slice(1)) {
    const v = demoScalar(d, mode)
    if (v[0] > bestV[0] || (v[0] === bestV[0] && v[1] > bestV[1])) {
      best = d
    }
  }
  return best
}

/**
 * 把已加载的作品切片整理成渲染单元：
 * - 同题组（≥2 件）产出一个 `group` 单元；单件组与未挂题作品产出普通 `demo` 单元；
 * - 组在它**第一件作品出现的位置**产出（未重排时保持服务端顺序）；
 * - `sort` 不是 `none` 时按组级口径重排全部单元（稳定：同值按原出现序）。
 *
 * 注意：分组与重排都只作用于**已加载切片**（服务端分页不变），
 * 所以组的排序值只代表「已加载组内最好的那件」，不是该题全量数据的口径。
 */
export function buildUnits<T extends GroupSortableDemo>(
  items: readonly T[],
  opts: { preferTaskSlug?: string; sort?: UnitSortMode } = {},
): ListUnit<T>[] {
  const mode = opts.sort ?? 'none'
  const prefer = opts.preferTaskSlug
  const groups = new Map<number, TaskGroup<T>>()
  for (const g of groupByTask(items, prefer)) {
    if (g.key !== null) groups.set(g.key, g)
  }

  const units: ListUnit<T>[] = []
  const emitted = new Set<number>()
  for (const d of items) {
    const task = primaryTask(d, prefer)
    if (!task) {
      units.push({ kind: 'demo', demo: d, key: `d:${d.slug}` })
      continue
    }
    const g = groups.get(task.id)!
    if (g.items.length < 2) {
      units.push({ kind: 'demo', demo: d, key: `d:${d.slug}` })
      continue
    }
    if (emitted.has(task.id)) continue
    emitted.add(task.id)
    units.push({
      kind: 'group',
      group: { ...g, items: sortByMode(g.items, mode) },
      rep: groupRepresentative(g.items, mode),
      key: `g:${task.id}`,
    })
  }

  if (mode === 'none') return units
  const order = new Map(units.map((u, i) => [u.key, i] as const))
  const value = new Map(
    units.map((u) => [u.key, u.kind === 'group' ? groupScalar(u.group.items, mode) : demoScalar(u.demo, mode)] as const),
  )
  return [...units].sort((a, b) => {
    const va = value.get(a.key)!
    const vb = value.get(b.key)!
    if (vb[0] !== va[0]) return vb[0] - va[0]
    if (vb[1] !== va[1]) return vb[1] - va[1]
    return (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0)
  })
}

/** 组内展示序：与组级排序同口径（代表件落在第一位） */
function sortByMode<T extends GroupSortableDemo>(items: readonly T[], mode: UnitSortMode): T[] {
  if (mode === 'none' || items.length < 2) return [...items]
  return [...items].sort((a, b) => {
    const va = demoScalar(a, mode)
    const vb = demoScalar(b, mode)
    return vb[0] - va[0] || vb[1] - va[1]
  })
}

