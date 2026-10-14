// 第二批（P-02/P-04/P-05/P-06）前端定向回归。
//
// 锁住修复前真实存在、修复后必须保持的行为：
//   P-04 useListPage 竞态：慢网下旧响应不得覆盖新结果（世代号守卫）；
//   P-05 useDemoFilters：导航到无参数 URL 必须清空筛选状态（URL 是唯一真源），
//        同时保持「自家写 URL 不再触发重查」的幂等不变量，且不误伤未提交的搜索草稿；
//   P-06 上传页「站内战绩」的取值口径（词表值可能是实体 name 而非 slug）——
//        后端解析侧由 backend/tests/test_list_filter_consistency.py 覆盖。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

// 与 tests/demoFilters.test.ts 同款：响应式假 route + 记录型 router（合成器只用这两个 API）。
// 必须响应式，否则 watch 跟踪不到 query 变化，测不出「自家写入不触发重查」。
const mockRouter = vi.hoisted(() => ({ replaced: [] as Record<string, string>[] }))

vi.mock('vue-router', async () => {
  const { ref } = await import('vue')
  const query = ref<Record<string, string>>({})
  return {
    __query: query,
    useRoute: () => ({
      get query() {
        return query.value
      },
    }),
    useRouter: () => ({
      replace: (arg: { query: Record<string, string> }) => {
        mockRouter.replaced.push(arg.query)
        query.value = { ...arg.query } // 模拟真实路由：写完 query 会回流到 route.query
        return Promise.resolve()
      },
    }),
  }
})

import { useDemoFilters } from '../src/composables/useDemoFilters'
import { useListPage } from '../src/composables/useListPage'
import { __query as queryRef } from 'vue-router'

const replaced = mockRouter.replaced

/** 直接改「浏览器地址栏」：模拟外部导航 */
function setQuery(q: Record<string, string>) {
  ;(queryRef as unknown as { value: Record<string, string> }).value = q
}

beforeEach(() => {
  ;(queryRef as unknown as { value: Record<string, string> }).value = {}
  replaced.length = 0
  localStorage.clear()
})

// ---------- P-04：useListPage 世代号 ----------

describe('P-04 useListPage：旧请求不得覆盖新结果', () => {
  it('慢的旧请求后返回时，items/total 保持最新请求的结果', async () => {
    let resolveSlow: ((v: { items: string[]; total: number }) => void) | null = null
    let call = 0
    const page = useListPage<string>(() => {
      call += 1
      if (call === 1) {
        return new Promise((res) => {
          resolveSlow = res as typeof resolveSlow
        })
      }
      return Promise.resolve({ items: ['B'], total: 1 })
    })

    const slow = page.load() // 第 1 次（旧，慢）
    await page.apply() // 第 2 次（新，快）
    expect(page.items.value).toEqual(['B'])

    // 旧请求此刻才返回：不得覆盖
    resolveSlow?.({ items: ['A-stale'], total: 99 })
    await slow
    expect(page.items.value).toEqual(['B'])
    expect(page.total.value).toBe(1)
    expect(page.loading.value).toBe(false) // 归最新那次管，不能被旧请求提前置 false 或被卡住
  })

  it('正常单次加载仍写结果并结束 loading（不误伤）', async () => {
    const page = useListPage<string>(() => Promise.resolve({ items: ['x'], total: 7 }))
    await page.load()
    expect(page.items.value).toEqual(['x'])
    expect(page.total.value).toBe(7)
    expect(page.loading.value).toBe(false)
  })

  it('被作废的旧请求失败不得写 error（最新请求的 error 才有效）', async () => {
    let call = 0
    const page = useListPage<string>(() => {
      call += 1
      if (call === 1) return new Promise((_res, rej) => setTimeout(() => rej(new Error('old fail')), 5))
      return Promise.reject(new Error('new fail'))
    })
    // 既有语义：load() 内部 catch，不向调用方抛出（视图靠 error ref 呈现）
    const slow = page.load()
    await page.apply()
    expect(page.error.value).toBe('new fail') // 最新请求的失败写入 error
    await new Promise((r) => setTimeout(r, 15))
    await slow
    expect(page.error.value).toBe('new fail') // 旧请求的失败不得覆盖
    expect(page.loading.value).toBe(false)
  })

  it('翻页（page 递增）仍复用同一 load 路径并写结果', async () => {
    let lastPage = 0
    const page = useListPage<string>((p) => {
      lastPage = p.page
      return Promise.resolve({ items: [`p${p.page}`], total: 3 })
    })
    page.page.value = 2
    await page.load()
    expect(lastPage).toBe(2)
    expect(page.items.value).toEqual(['p2'])
  })
})

// ---------- P-05：URL 是唯一真源 ----------

describe('P-05 useDemoFilters：路由参数清空必须同步状态', () => {
  it('从带筛选的 URL 导航到无参数 URL：筛选状态全部清空且被识别为真变化', () => {
    const f = useDemoFilters({ onChange: () => {} })
    setQuery({ tag: 'type:demo,model:dsv4-flash', q: '粒子', model: 'dsv4-pro', sort: 'popular' })
    expect(f.applyRouteQuery()).toBe(true)
    expect(f.selectedTags.value).toEqual(['type:demo', 'model:dsv4-flash'])
    expect(f.submittedQ.value).toBe('粒子')

    // 模拟点击顶栏「作品库」→ 裸 /demos
    setQuery({})
    expect(f.applyRouteQuery()).toBe(true) // 修复前该分支直接 false 早退 → 不重查
    expect(f.selectedTags.value).toEqual([]) // 修复前保持旧筛选（本用例的核心断言）
    expect(f.submittedQ.value).toBe('')
    expect(f.modelFilter.value).toBe('')
    expect(f.q.value).toBe('')
  })

  it('URL 移除单个参数时该项被清空，其余保留', () => {
    const f = useDemoFilters({ onChange: () => {} })
    setQuery({ tag: 'type:demo', q: 'x' })
    f.applyRouteQuery()
    setQuery({ tag: 'type:demo' }) // 只去掉 q
    expect(f.applyRouteQuery()).toBe(true)
    expect(f.selectedTags.value).toEqual(['type:demo'])
    expect(f.submittedQ.value).toBe('')
  })

  it('幂等不变量保持：URL 与状态一致时返回 false（自家写入不算新导航）', () => {
    const f = useDemoFilters({ onChange: () => {} })
    f.selectedTags.value = ['type:demo']
    f.submittedQ.value = 'x'
    setQuery({ tag: 'type:demo', q: 'x' })
    expect(f.applyRouteQuery()).toBe(false)
  })

  it('URL 未涉及 q 时，不抹掉用户正在输入但未提交的草稿', () => {
    const f = useDemoFilters({ onChange: () => {} })
    f.q.value = '正在输入' // 草稿，未提交
    setQuery({ tag: 'type:demo' })
    expect(f.applyRouteQuery()).toBe(true)
    expect(f.selectedTags.value).toEqual(['type:demo'])
    expect(f.submittedQ.value).toBe('')
    expect(f.q.value).toBe('正在输入') // 草稿保留
  })

  it('路由 watch：外部清空 URL 会触发且只触发一次重查', async () => {
    const onChange = vi.fn()
    const f = useDemoFilters({ onChange })
    setQuery({ tag: 'type:demo' })
    await nextTick()
    expect(onChange).toHaveBeenCalledTimes(1)
    setQuery({})
    await nextTick()
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(f.selectedTags.value).toEqual([])
    await nextTick()
    expect(onChange).toHaveBeenCalledTimes(2) // 幂等：不重复
  })

  it('sort 的既有回退语义未变：URL 无 sort 时回落当前排序，非法值不崩', () => {
    const f = useDemoFilters({ onChange: () => {} })
    f.sort.value = 'popular'
    setQuery({}) // 无 sort
    f.applyRouteQuery()
    expect(f.sort.value).toBe('popular') // 保持：缺省 newest 本就不写进 URL（见 syncQuery）
    setQuery({ sort: 'weird' })
    f.applyRouteQuery()
    expect(f.sort.value).toBe('popular') // 非法值回落当前，不崩
  })
})
