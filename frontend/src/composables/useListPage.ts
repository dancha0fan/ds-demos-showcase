import { ref } from 'vue'

export interface ListResult<T> {
  items: T[]
  total: number
}

/** 通用列表页状态：分页/加载/错误/刷新。fetcher 只接收分页参数，外部用闭包携带筛选条件。 */
export function useListPage<T>(fetcher: (params: { page: number; page_size: number }) => Promise<ListResult<T>>, pageSize = 20) {
  const items = ref<T[]>([])
  const total = ref(0)
  const page = ref(1)
  const loading = ref(false)
  const error = ref('')

  // 世代号守卫（P-04）：调用方在改筛选/排序后立即 apply()（page=1 的新请求），
  // 与在途的旧请求并发；慢网下旧响应后到会把 items/total 覆盖成上一组条件的
  // —— 列表内容与当前选中的排序/搜索词不一致。只允许最新一次请求写结果。
  // 与仓库既有做法同源（useLoadGeneration / useDebouncedFetch 的世代号）。
  let gen = 0

  async function load() {
    const my = ++gen
    loading.value = true
    error.value = ''
    try {
      const res = await fetcher({ page: page.value, page_size: pageSize })
      if (my !== gen) return // 已有更新的请求发出：本次结果作废，且不动 loading（它归最新那次管）
      items.value = res.items
      total.value = res.total
    } catch (e) {
      if (my !== gen) return
      error.value = (e as Error).message
    } finally {
      if (my === gen) loading.value = false
    }
  }

  function apply() {
    page.value = 1
    return load()
  }

  return { items, total, page, pageSize, loading, error, load, apply }
}
