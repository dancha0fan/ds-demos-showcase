import { createApp } from 'vue'
import { createPinia } from 'pinia'
import interWoff2 from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url'
import { isAstraSite } from './astra/scope'
import { lang, loadEn } from './i18n'

// 双域名分叉（docs/astra橱窗分离.md）：
// astrademos.top → 极简橱窗 mini-SPA（main-astra 独立路由/壳层，主站 App/router 代码不加载）；
// 其余域名（deepdemos.top 等）→ 主站原路径，astra.css 以更高特异度覆盖。
// P1-4 astra 卸载（04 §5.5）：主站 styles/ 改入主站分支动态加载——
// astra 视区不再背主站样式（原 108KB 级），41/41 ax-* 类隔离结论不受影响（astra.css 自足）。
if (isAstraSite()) {
  import('./astra/main-astra').then(({ mountAstraApp }) => mountAstraApp())
} else {
  void (async () => {
    // preload 标题字体（04 §2.4）：运行时注入（vite 哈希 URL 由 import 取得）
    const pre = document.createElement('link')
    pre.rel = 'preload'
    pre.as = 'font'
    pre.type = 'font/woff2'
    pre.crossOrigin = ''
    pre.href = interWoff2
    document.head.appendChild(pre)
    // 以下资源同时起跑、全部就绪才挂载：逐个 await 会让首屏串行等 4~5 个往返。
    // 英文用户：词表就绪再挂载（04 §5.3，P2-2），避免首帧中文回落闪帧；加载失败不阻塞（t() 回落中文）
    const en = lang.value === 'en' ? loadEn().catch(() => undefined) : undefined
    // 构建产物里样式表 <link> 按调用顺序插入，层叠序与原先一致；
    // 开发服务器的样式由模块求值时注入（求值序 = 到达序），所以 dev 下仍让全局样式先于壳层
    const styles = Promise.all([import('./styles/fonts.css'), import('./styles/index.css')])
    if (import.meta.env.DEV) await styles
    const [{ default: App }, { default: router }] = await Promise.all([import('./App.vue'), import('./router'), styles, en])
    const app = createApp(App)
    app.use(createPinia())
    app.use(router)
    app.mount('#app')
  })()
}
