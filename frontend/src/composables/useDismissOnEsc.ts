import { getCurrentInstance, onBeforeUnmount, watch } from 'vue'
import type { Ref } from 'vue'

/**
 * 浮层按 Esc 关闭（站点浮层的统一做法）。
 *
 * 为什么要单独一个 composable：
 *   · 项目里"打开浮层 → 注册一次性 keydown → 关闭即注销"这套写法已经出现过多次，
 *     每写一遍都要小心"监听没注销"和"闭包拿到旧值"；
 *   · 更现实的原因：**预览全屏那条护栏**（tests/previewFullscreenGuard.test.ts）禁止
 *     `DemoView.vue` / `IframePreview.vue` 里出现 Esc 分支 —— 因为那两个文件曾经用 Esc 退全屏，
 *     把作品的 Esc 菜单抢了。把"站点浮层的 Esc"集中到这里，护栏就能继续按文件粒度生效，
 *     不必为了新增一个收藏面板去放宽它。
 *
 * 不变量（P-11 补齐第二条）：
 *   ① 面板关闭时**一定**注销监听（自停 watch，不依赖调用方记得清理）；
 *   ② 面板**开着**时组件被卸载也必须注销 —— 卸载会停止 watch，内层回调不会执行，
 *      只靠 ① 会把监听器留在 document 上（每实例泄漏一份，此后按 Esc 还会调用已卸载组件的回调）。
 */
export function useDismissOnEsc(open: Ref<boolean>, close: () => void) {
  let detach: (() => void) | null = null

  watch(open, (isOpen) => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    detach = () => document.removeEventListener('keydown', onKey)
    const stop = watch(open, (v) => {
      if (!v) {
        detach?.()
        detach = null
        stop()
      }
    })
  })

  // 只在组件上下文注册（合成器也可能在测试/非组件环境被调用）——与仓库其它合成器同约定
  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      detach?.()
      detach = null
    })
  }
}
