// RF-4h：打字机时序单测。
//
// 这段逻辑原先内联在 HomeView 的 setup 里（26 行 + 4 个闭包变量），与组件实例绑死 ——
// 「打完 → 停顿 → 退格 → 换下一句」这条时序**一行都测不到**。抽成合成器后
// 用 fake timers 可以把整条链钉死。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref, nextTick } from 'vue'
import { useTypewriter } from '../src/composables/useTypewriter'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useTypewriter：逐字 → 停顿 → 退格 → 换句', () => {
  it('第一拍同步出第一个字，之后按 typeMs 逐字追加', async () => {
    vi.useFakeTimers()
    const phrases = ref(['ab'])
    const { text } = useTypewriter(phrases, { typeMs: 10, eraseMs: 5, holdMs: 100 })
    expect(text.value).toBe('a') // 启动即打第一字（与原实现一致）
    await vi.advanceTimersByTimeAsync(10)
    expect(text.value).toBe('ab')
  })

  it('打完停在完整句上 holdMs，再按 eraseMs 逐字退回', async () => {
    vi.useFakeTimers()
    const phrases = ref(['ab'])
    const { text } = useTypewriter(phrases, { typeMs: 10, eraseMs: 5, holdMs: 100 })
    await vi.advanceTimersByTimeAsync(10) // → 'ab' 完成，进入停顿（下一拍在 +100）
    expect(text.value).toBe('ab')
    await vi.advanceTimersByTimeAsync(99) // 停顿未满：还是完整句
    expect(text.value).toBe('ab')
    // 注意窗口粒度：advanceTimersByTimeAsync 会把窗口内**链式**触发的定时器一并跑掉，
    // 所以这里必须一次只推进「到下一个事件为止」，否则会连退好几格。
    await vi.advanceTimersByTimeAsync(1) // 停顿结束 → 退一格（下一拍在 +5）
    expect(text.value).toBe('a')
    await vi.advanceTimersByTimeAsync(5) // 再退一格 → 退光
    expect(text.value).toBe('')
  })

  it('退光后换下一句（多句池）', async () => {
    vi.useFakeTimers()
    const phrases = ref(['a', 'b'])
    const { text } = useTypewriter(phrases, { typeMs: 10, eraseMs: 5, holdMs: 20 })
    await vi.advanceTimersByTimeAsync(10) // 'a' 完成
    await vi.advanceTimersByTimeAsync(20) // 停顿
    await vi.advanceTimersByTimeAsync(5) // 退光 → idx 前进
    await vi.advanceTimersByTimeAsync(10) // 开始打第二句
    expect(text.value).toBe('b')
  })

  it('单句池子反复打同一句（取模不越界、不死循环）', async () => {
    vi.useFakeTimers()
    const phrases = ref(['x'])
    const { text } = useTypewriter(phrases, { typeMs: 10, eraseMs: 5, holdMs: 20 })
    await vi.advanceTimersByTimeAsync(10)
    expect(text.value).toBe('x')
    await vi.advanceTimersByTimeAsync(20 + 5 + 10)
    expect(text.value).toBe('x') // 又打回来了
  })

  it('空池不崩（回落空串）', async () => {
    vi.useFakeTimers()
    const phrases = ref<string[]>([])
    const { text } = useTypewriter(phrases, { typeMs: 10, holdMs: 10 })
    await vi.advanceTimersByTimeAsync(50)
    expect(text.value).toBe('')
  })

  it('stop() 之后不再改动文本', async () => {
    vi.useFakeTimers()
    const { text, stop } = useTypewriter(ref(['abc']), { typeMs: 10, eraseMs: 5, holdMs: 50 })
    await vi.advanceTimersByTimeAsync(10)
    const frozen = text.value
    stop()
    await vi.advanceTimersByTimeAsync(500)
    expect(text.value).toBe(frozen)
  })

  it('词池变化时从头重打（不会用旧下标切新词）', async () => {
    vi.useFakeTimers()
    const phrases = ref(['aaa'])
    const { text } = useTypewriter(phrases, { typeMs: 10, eraseMs: 5, holdMs: 50 })
    await vi.advanceTimersByTimeAsync(20) // 打到 'aaa'
    expect(text.value).toBe('aaa')
    phrases.value = ['bb'] // 切语言/整活模式换池
    await nextTick()
    expect(text.value).toBe('b') // 立即从新池第一字重打
    await vi.advanceTimersByTimeAsync(10)
    expect(text.value).toBe('bb')
  })
})

describe('useTypewriter：KeepAlive 暂停与减弱动效', () => {
  it('pause() 冻结在当前字位，resume() 从原处接着打（不从头重来）', async () => {
    vi.useFakeTimers()
    const { text, pause, resume } = useTypewriter(ref(['abcd']), { typeMs: 10, eraseMs: 5, holdMs: 50 })
    await vi.advanceTimersByTimeAsync(10)
    expect(text.value).toBe('ab')
    pause()
    await vi.advanceTimersByTimeAsync(1000)
    expect(text.value).toBe('ab')
    resume()
    await vi.advanceTimersByTimeAsync(10)
    expect(text.value).toBe('abc')
  })

  it('暂停期间换词池：重打但保持暂停，resume 后才动', async () => {
    vi.useFakeTimers()
    const phrases = ref(['aaa'])
    const { text, pause, resume } = useTypewriter(phrases, { typeMs: 10, eraseMs: 5, holdMs: 50 })
    pause()
    phrases.value = ['xy']
    await nextTick()
    expect(text.value).toBe('x')
    await vi.advanceTimersByTimeAsync(500)
    expect(text.value).toBe('x')
    resume()
    await vi.advanceTimersByTimeAsync(10)
    expect(text.value).toBe('xy')
  })

  it('prefers-reduced-motion：直接给一句完整静态文案，之后不再变化', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { matchMedia: (q: string) => ({ matches: q.includes('reduce') }) })
    const pool = ['第一句', '第二句']
    const { text, resume } = useTypewriter(ref(pool), { typeMs: 10, eraseMs: 5, holdMs: 20 })
    expect(pool).toContain(text.value)
    const shown = text.value
    resume()
    await vi.advanceTimersByTimeAsync(1000)
    expect(text.value).toBe(shown)
  })
})
