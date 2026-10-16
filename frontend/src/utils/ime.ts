/**
 * 输入法组合中（拼音/注音/日文候选还没上屏）的按键不是"提交 / 导航"意图。
 *
 * 必须挂在 keydown 上判断：Chrome 里确认候选的那次 Enter，keydown 带 isComposing，
 * 而 keyup 时 compositionend 已经发过、isComposing 为 false —— `@keyup.enter` 会把"选词"当成"提交"。
 * Safari 的那次 keydown 的 isComposing 也是 false，只能靠 keyCode 229 认出来。
 */
export function isImeComposing(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229
}
