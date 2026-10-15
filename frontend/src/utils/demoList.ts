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
