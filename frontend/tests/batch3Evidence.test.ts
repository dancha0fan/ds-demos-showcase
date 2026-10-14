// 第三批定向证据（P-10/P-11/P-12）——修复前会失败，用于证明问题真实存在。
//
// 口径：只测这三个 composable/store 的纯逻辑，不碰组件与后端。
//   P-10：打开挂题选择器时的预填推荐被去抖 watch 清空（时序问题）
//   P-11：组件卸载时 document keydown 监听未移除（泄漏）
//   P-12：词表请求失败时既有缓存被清空
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'

// ---------- P-10 ----------

describe('P-10 useTaskMount：打开选择器的预填推荐', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
  })

  it('正文已够长时打开选择器，预填结果应保留而非被清空', async () => {
    const fetchCalls: string[] = []
    vi.doMock('../src/api', () => ({
      api: {
        suggestTasks: async (q: string) => {
          fetchCalls.push(q)
          return [{ slug: 't1', title: `命中：${q.slice(0, 6)}`, sim: 0.8, demo_count: 1 }]
        },
      },
    }))

    const { useTaskMount } = await import('../src/composables/useTaskMount')
    const title = ref('星云可视化')
    const description = ref('用粒子做一片会呼吸的星云')
    const prompt = ref('让星云缓慢呼吸')
    const mount = useTaskMount({ title, description, prompt, aside: () => {} })

    // 打开选择器：设计意图是「带着已填内容去搜一次」
    mount.openTaskPicker()
    await vi.advanceTimersByTimeAsync(400) // 越过 320ms 去抖
    await nextTick()

    expect(fetchCalls.length).toBeGreaterThan(0) // 确实发起了搜索
    expect(mount.taskHits.value.length, '预填推荐应可见（修复前被清空）').toBeGreaterThan(0)
    expect(fetchCalls.at(-1)).toContain('星云')
  })

  it('打开选择器后的显式搜索不应被随后的去抖空请求作废', async () => {
    const fetchCalls: string[] = []
    vi.doMock('../src/api', () => ({
      api: {
        suggestTasks: async (q: string) => {
          fetchCalls.push(q)
          return [{ slug: 't1', title: '命中', sim: 0.8, demo_count: 1 }]
        },
      },
    }))
    const { useTaskMount } = await import('../src/composables/useTaskMount')
    const mount = useTaskMount({
      title: ref('星云可视化'),
      description: ref('用粒子做一片会呼吸的星云'),
      prompt: ref('让星云缓慢呼吸'),
      aside: () => {},
    })
    mount.openTaskPicker()
    // 打开后长按时间推进：修复前 320ms 处会跑一次 run('') 清空并作废显式搜索
    await vi.advanceTimersByTimeAsync(1000)
    await nextTick()
    expect(mount.taskHits.value.length, '显式搜索结果应保留（修复前被空 run 清空）').toBeGreaterThan(0)
    // 空 key 不应发出请求（source 会短路成 ''，minLength 挡住）
    expect(fetchCalls.every((c) => c.trim().length >= 2), `不应有空请求：${JSON.stringify(fetchCalls)}`).toBe(true)
  })
})

// ---------- P-11 ----------
//
// 环境约定（同 setup-browser-globals.ts 与 composables.test.ts）：本仓纯逻辑测试跑 node 环境、
// **不装真 document**。需要 document 的用例在调用前局部 stub（这里用记录型假 document，
// 不引 jsdom —— 与 useBodyScrollLock 用例同一做法）。

function fakeDocument() {
  const listeners = new Set<(e: KeyboardEvent) => void>()
  const handlers = new Map<string, Set<(e: unknown) => void>>()
  // 最小 DOM 面：让 Vue 的 createApp().mount()/unmount() 能走完生命周期即可
  // （挂载与卸载是我们要验的触发点；渲染结果不在断言范围）。
  function fakeNode(tag = 'div'): Record<string, unknown> {
    const node: Record<string, unknown> = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      style: {},
      children: [] as unknown[],
      parentNode: null,
      firstChild: null,
      nextSibling: null,
      textContent: '',
      namespaceURI: 'http://www.w3.org/1999/xhtml',
      appendChild(c: unknown) {
        ;(node.children as unknown[]).push(c)
        return c
      },
      insertBefore(c: unknown) {
        ;(node.children as unknown[]).unshift(c)
        return c
      },
      removeChild(c: unknown) {
        const a = node.children as unknown[]
        const i = a.indexOf(c)
        if (i >= 0) a.splice(i, 1)
        return c
      },
      remove() {},
      setAttribute() {},
      removeAttribute() {},
      addEventListener() {},
      removeEventListener() {},
      querySelector: () => null,
    }
    return node
  }
  const body = fakeNode('body')
  const doc = {
    body,
    createElement: (tag: string) => fakeNode(tag),
    createTextNode: (t: string) => ({ nodeType: 3, textContent: t, parentNode: null }),
    createComment: () => ({ nodeType: 8, parentNode: null }),
    querySelector: () => null,
    addEventListener(type: string, fn: (e: unknown) => void) {
      if (type === 'keydown') listeners.add(fn as (e: KeyboardEvent) => void)
      if (!handlers.has(type)) handlers.set(type, new Set())
      handlers.get(type)!.add(fn)
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      if (type === 'keydown') listeners.delete(fn as (e: KeyboardEvent) => void)
      handlers.get(type)?.delete(fn)
    },
    /** 模拟用户按 Esc */
    dispatchKey(key: string) {
      for (const fn of [...listeners]) fn({ key } as KeyboardEvent)
    },
    get keydownCount() {
      return listeners.size
    },
  }
  return doc
}

describe('P-11 useDismissOnEsc：卸载时必须注销监听', () => {
  it('面板打开状态下卸载组件，keydown 监听应被移除', async () => {
    const doc = fakeDocument()
    vi.stubGlobal('document', doc)

    const { useDismissOnEsc } = await import('../src/composables/useDismissOnEsc')
    // 用 createRenderer + 空操作宿主：只跑生命周期（mount/unmount），不需要任何真实 DOM
    // —— 项目测试跑 node 环境，铺假 DOM 会越铺越大（runtime-dom 要 SVGElement/window/…）。
    const { createRenderer, defineComponent } = await import('vue')
    const noop = () => {}
    const nodeOps = {
      createElement: () => ({}) as never,
      createText: () => ({}) as never,
      createComment: () => ({}) as never,
      setText: noop,
      setElementText: noop,
      insert: noop,
      remove: noop,
      parentNode: () => null,
      nextSibling: () => null,
      querySelector: () => null,
      setScopeId: noop,
      patchProp: noop,
      createComment_: noop,
    }
    const { createApp } = createRenderer(nodeOps as never)

    const open = ref(false)
    const close = vi.fn()
    const Comp = defineComponent({
      setup() {
        useDismissOnEsc(open, close)
        open.value = true // 打开面板（注册监听）
        return () => null
      },
    })

    const app = createApp(Comp)
    app.mount({} as never)
    await nextTick()

    expect(doc.keydownCount, '打开时应注册 keydown').toBe(1)

    app.unmount() // 面板仍开着就卸载 —— 修复前监听残留
    await nextTick()

    expect(doc.keydownCount, '卸载时应移除 keydown（修复前残留 1 个）').toBe(0)

    // 卸载后按 Esc 不应再调用已卸载组件的回调
    const before = close.mock.calls.length
    doc.dispatchKey('Escape')
    expect(close.mock.calls.length, '卸载后 Esc 不应触发已卸载组件的回调').toBe(before)

    vi.unstubAllGlobals()
  })

  it('正常 Esc 关闭仍工作，且关闭后不重复响应（不误伤）', async () => {
    const doc = fakeDocument()
    vi.stubGlobal('document', doc)

    const { useDismissOnEsc } = await import('../src/composables/useDismissOnEsc')
    const open = ref(false)
    const close = vi.fn(() => {
      open.value = false
    })
    // 非组件环境：无卸载清理需求，只验 Esc 语义
    useDismissOnEsc(open, close)
    open.value = true
    await nextTick() // 等外层 watch(open) 注册监听
    expect(doc.keydownCount).toBe(1)
    doc.dispatchKey('Escape')
    expect(close).toHaveBeenCalledTimes(1)
    await nextTick() // 等内层 watch 注销
    doc.dispatchKey('Escape')
    expect(close, '关闭后应已注销，不再触发').toHaveBeenCalledTimes(1)

    vi.unstubAllGlobals()
  })
})

// ---------- P-12 ----------

describe('P-12 tags store：刷新失败不得清空既有可用缓存', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    vi.doUnmock('../src/api')
  })

  it('refresh 失败时保留旧缓存（修复前被清空为 []）', async () => {
    let fail = false
    vi.doMock('../src/api', () => ({
      api: {
        listTagKeys: async () => {
          if (fail) throw new Error('network down')
          return [{ key: 'model', mode: 'fixed', label: '模型', description: '', sort: 1, values: [], demo_count: 0 }]
        },
      },
    }))
    const { createPinia, setActivePinia } = await import('pinia')
    setActivePinia(createPinia())
    const { useTagsStore } = await import('../src/stores/tags')

    const s = useTagsStore()
    await s.load()
    expect(s.keys.length, '首次加载应成功').toBe(1)
    expect(s.loaded).toBe(true)

    // 刷新时网络失败
    fail = true
    await s.refresh()
    expect(s.keys.length, '失败时不应清空既有缓存（修复前为 0）').toBe(1)
    expect(s.loaded, '失败不应置 loaded（允许下次重试）').toBe(false)

    // 恢复后能重新加载
    fail = false
    await s.refresh()
    expect(s.keys.length).toBe(1)
    expect(s.loaded).toBe(true)
  })

  it('首次加载即失败：保持空、可重试、不抛异常', async () => {
    vi.doMock('../src/api', () => ({
      api: {
        listTagKeys: async () => {
          throw new Error('down')
        },
      },
    }))
    const { createPinia, setActivePinia } = await import('pinia')
    setActivePinia(createPinia())
    const { useTagsStore } = await import('../src/stores/tags')
    const s = useTagsStore()
    await expect(s.load()).resolves.toBeDefined() // 不抛
    expect(s.keys).toEqual([])
    expect(s.loaded).toBe(false)
    expect(s.loading, 'loading 必须复位').toBe(false)
    expect(s.keys.length, '失败后仍可重试（loaded=false）').toBe(0)
  })

  it('成功路径不受影响：并发去重与 force 语义保持', async () => {
    let calls = 0
    vi.doMock('../src/api', () => ({
      api: {
        listTagKeys: async () => {
          calls += 1
          return [{ key: 'k', mode: 'open', label: 'l', description: '', sort: 1, values: [], demo_count: 0 }]
        },
      },
    }))
    const { createPinia, setActivePinia } = await import('pinia')
    setActivePinia(createPinia())
    const { useTagsStore } = await import('../src/stores/tags')
    const s = useTagsStore()

    await s.load()
    await s.load() // loaded=true 且非 force → 不再请求
    expect(calls).toBe(1)
    await s.refresh() // force → 再请求一次
    expect(calls).toBe(2)
    expect(s.keys.length).toBe(1)
  })
})
