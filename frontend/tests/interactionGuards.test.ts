// 2026-10 前端体检的护栏（docs/uiux/log/2026-10-16-前端体检与优化.md）
//
// 这里钉的几件事都有一个共同点：构建/类型/原有单测全绿，只有在浏览器里实测才看得出来——
//   ① 匿名访客每次站内跳转都先阻塞一趟 GET /auth/me（user===null 永远为真）；
//   ② 中文输入法选词的回车被当成提交（keyup.enter / 未判组合态）；
//   ③ translate() 里塞空格分隔的偏移令牌，整条 transform 计算值为 none（全站按下不位移）；
//   ④ 页面登场的 transform 让页内 fixed 件先按页面坐标画一段再跳回视口；
//   ⑤ 页头眉标与 h1 逐字相同。
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { me, logout } = vi.hoisted(() => ({ me: vi.fn(), logout: vi.fn() }))
vi.mock('../src/api', () => ({ api: { me, logout } }))

const { useAuthStore } = await import('../src/stores/auth')
const { isImeComposing } = await import('../src/utils/ime')

const SRC = path.resolve(import.meta.dirname, '../src')

function* walk(dir: string, ext: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(p, ext)
    else if (e.name.endsWith(ext)) yield p
  }
}
const rel = (f: string) => f.replace(SRC, 'src').replace(/\\/g, '/')

describe('① 登录态只探测一次', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    me.mockReset()
    logout.mockReset()
  })

  it('匿名：首次探测之后再调用 ensureChecked 不再发请求', async () => {
    me.mockRejectedValue(new Error('401'))
    const auth = useAuthStore()
    expect(await auth.ensureChecked()).toBeNull()
    await auth.ensureChecked()
    await auth.ensureChecked()
    expect(me).toHaveBeenCalledTimes(1)
    expect(auth.checked).toBe(true)
  })

  it('并发调用共用同一个请求（首屏守卫 + 组件同时问）', async () => {
    let resolve!: (u: unknown) => void
    me.mockReturnValue(new Promise((r) => (resolve = r)))
    const auth = useAuthStore()
    const a = auth.ensureChecked()
    const b = auth.ensureChecked()
    resolve({ username: 'alice', role: 'user' })
    expect(await a).toEqual(await b)
    expect(me).toHaveBeenCalledTimes(1)
  })

  it('登出后不重新探测（登出本身就是确定的答案）', async () => {
    me.mockResolvedValue({ username: 'alice', role: 'user' })
    logout.mockResolvedValue(undefined)
    const auth = useAuthStore()
    await auth.ensureChecked()
    await auth.logout()
    await auth.ensureChecked()
    expect(me).toHaveBeenCalledTimes(1)
    expect(auth.isLoggedIn()).toBe(false)
  })

  it('路由守卫走 ensureChecked，而不是按 user===null 判断', () => {
    const router = readFileSync(path.join(SRC, 'router/index.ts'), 'utf8')
    expect(router).toMatch(/await auth\.ensureChecked\(\)/)
    expect(router).not.toMatch(/auth\.user === null/)
  })
})

describe('② 输入法组合态的回车不算提交', () => {
  it('isComposing 或 keyCode 229（Safari）都判为组合态；普通回车不是', () => {
    expect(isImeComposing({ isComposing: true, keyCode: 13 } as KeyboardEvent)).toBe(true)
    expect(isImeComposing({ isComposing: false, keyCode: 229 } as KeyboardEvent)).toBe(true)
    expect(isImeComposing({ isComposing: false, keyCode: 13 } as KeyboardEvent)).toBe(false)
  })

  it('文本框上的回车处理：不许用 keyup.enter，keydown.enter 必须先判 isImeComposing', () => {
    const offenders: string[] = []
    for (const f of walk(SRC, '.vue')) {
      const raw = readFileSync(f, 'utf8')
      for (const m of raw.matchAll(/<(input|textarea)\b(?:[^>"']|"[^"]*"|'[^']*')*>/g)) {
        const tag = m[0]
        const line = raw.slice(0, m.index).split('\n').length
        if (/@keyup\.enter/.test(tag)) offenders.push(`${rel(f)}:${line} 用了 keyup.enter`)
        else if (/@keydown\.enter/.test(tag) && !/isImeComposing\(\$event\)/.test(tag)) offenders.push(`${rel(f)}:${line} 没判组合态`)
      }
    }
    expect(offenders, '拼音选词的回车会被当成提交：\n' + offenders.join('\n')).toEqual([])
  })

  it('脚本里处理 Enter 的输入组件（全局搜索/实体选择器）必须先判组合态', () => {
    for (const f of ['components/SearchOverlay.vue', 'components/picker/EntityPicker.vue']) {
      const raw = readFileSync(path.join(SRC, f), 'utf8')
      expect(raw, f).toMatch(/isImeComposing\(e\)/)
    }
  })
})

describe('③ translate() 函数里不许塞 --sh-off-* / --lift-flat', () => {
  // 这两类令牌是给 box-shadow 拼接用的空格分隔值（"4px 4px"），translate() 要求逗号分隔，
  // 整条 transform 声明在计算期失效（= none）。2026-10 实测：全站按钮/标签/卡片按下只清影、不位移。
  // 正确写法是独立的 translate 属性：`translate: var(--sh-off-md)`。
  it('样式表与 .vue 的 <style> 里都没有这种写法', () => {
    const offenders: string[] = []
    const files = [...walk(SRC, '.css'), ...walk(SRC, '.vue')]
    for (const f of files) {
      const raw = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      for (const m of raw.matchAll(/translate\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g)) {
        if (/var\(--(sh-off|lift-flat)/.test(m[0])) offenders.push(`${rel(f)} → ${m[0]}`)
      }
    }
    expect(offenders, '改用独立的 translate 属性（接受空格分隔值）：\n' + offenders.join('\n')).toEqual([])
  })

  it('微交互库的按下规则用 translate 属性承载位移', () => {
    const lib = readFileSync(path.join(SRC, 'styles/components/lift.css'), 'utf8')
    expect(lib).toMatch(/:active\s*\{[^}]*translate:\s*var\(--lift-flat, var\(--sh-off-md\)\)/)
  })
})

describe('④ 页面登场期间，页内常驻的 fixed 件不画', () => {
  it('motion.css 有 .page-enter-active .page-float 规则', () => {
    const motion = readFileSync(path.join(SRC, 'styles/tokens/motion.css'), 'utf8')
    expect(motion).toMatch(/\.page-enter-active \.page-float\s*\{\s*visibility:\s*hidden/)
  })

  it('论坛斜角 Tab、详情页竖轨与移动动作栏都挂了 .page-float', () => {
    const home = readFileSync(path.join(SRC, 'views/HomeView.vue'), 'utf8')
    const detail = readFileSync(path.join(SRC, 'views/DemoView.vue'), 'utf8')
    expect(home).toMatch(/class="[^"]*\bforum-peek\b[^"]*\bpage-float\b/)
    expect(detail).toMatch(/class="[^"]*\bdv-rail\b[^"]*\bpage-float\b/)
    expect(detail).toMatch(/class="[^"]*\bdv-mbar\b[^"]*\bpage-float\b/)
  })
})

describe('⑤ 页头眉标不复读标题', () => {
  // 眉标是上级分类（"模型图鉴 / 模型"）；与 h1 逐字相同（曾有"作品库 / 作品库"等 4 页）就是噪音
  it('PageHero 里 eyebrow 与 page-title 的内容不相同', () => {
    const offenders: string[] = []
    for (const f of walk(path.join(SRC, 'views'), '.vue')) {
      const hero = /<PageHero[\s\S]*?<\/PageHero>/.exec(readFileSync(f, 'utf8'))?.[0]
      if (!hero) continue
      const eyebrow = /<span class="eyebrow">([\s\S]*?)<\/span>/.exec(hero)?.[1].trim()
      const title = /<h1 class="page-title">([\s\S]*?)<\/h1>/.exec(hero)?.[1].trim()
      if (eyebrow && eyebrow === title) offenders.push(`${rel(f)} → ${eyebrow}`)
    }
    expect(offenders).toEqual([])
  })
})
