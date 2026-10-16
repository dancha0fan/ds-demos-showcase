import { createRouter, createWebHistory } from 'vue-router'
import { routes } from './routes'
import { useAuthStore } from '../stores/auth'
import { api } from '../api'
import { titleBase } from '../utils/funMode'
import { routeTitle } from '../i18n'

/** 锚点目标常在异步数据回来后才渲染（如 /about#sponsors）：最多等 3s，等不到就回顶 */
function waitForAnchor(hash: string): Promise<Element | null> {
  let id = hash.slice(1)
  try {
    id = decodeURIComponent(id)
  } catch {
    /* 非法转义按原文找 */
  }
  const deadline = performance.now() + 3000
  return new Promise((resolve) => {
    const tick = () => {
      const el = document.getElementById(id)
      if (el || performance.now() > deadline) resolve(el)
      else requestAnimationFrame(tick)
    }
    tick()
  })
}

const router = createRouter({
  history: createWebHistory(),
  routes,
  async scrollBehavior(to, from, savedPosition) {
    // 浏览器返回/前进时恢复滚动位置
    if (savedPosition) return { ...savedPosition, behavior: 'instant' }
    if (to.hash && (to.hash !== from.hash || to.path !== from.path)) {
      const el = await waitForAnchor(to.hash)
      // 同页锚点保留 CSS 的平滑滚动；跨页直接落位（新页面从顶部"滑"下去只是等待）
      if (el) return { el, top: 16, behavior: to.path === from.path ? 'auto' : 'instant' }
    }
    // 同一路由只改 query（排序 / 筛选 / 分页 / 加载更多）绝不回顶部：
    // 那会让「再显示 24 件」看起来毫无反应（实测症状），也会打断阅读位置。
    if (to.path === from.path) return false
    // html 上有 scroll-behavior: smooth —— 换页必须显式 instant，否则每次跳转都会先看一段回滚动画
    return { top: 0, behavior: 'instant' }
  },
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  await auth.ensureChecked()
  if (to.meta.requiresAuth && !auth.isLoggedIn()) {
    return { path: '/login', query: { redirect: to.fullPath } }
  }
  if (to.meta.requiresAdmin && !auth.isAdmin()) {
    return { path: '/' }
  }
  return true
})

router.afterEach((to) => {
  // 页面标题随语言切换（routeTitle 映射）+ 站点名随 fun/i18n 切换（titleBase）
  const pageTitle = to.meta.title ? routeTitle(String(to.meta.title)) : ''
  document.title = pageTitle ? `${pageTitle} · ${titleBase.value}` : titleBase.value
  // 页面访问打点：一次路由切换 = 一次浏览（原始 PV +1）
  api.reportVisit()
})

// 实时在线心跳：每 30s 发一次（模块级，单页一次）。
// 后台标签页停发（visibilityState 判定）：休眠窗口不打点，避免无意义请求与失真在线数（P0-3）；
// 回到前台立即补一拍——上次心跳可能已是 30s+ 之前，消除休眠间隙。
setInterval(() => {
  if (document.visibilityState === 'visible') api.reportHeartbeat()
}, 30_000)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') api.reportHeartbeat()
})

export default router
