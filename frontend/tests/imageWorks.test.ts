// 图像作品一期：前端侧关键口径（钉住语义，不重复渲染实现）
//
// 三件事：
//   ① 上传向导的 image 类型卡存在，且类型联合已放行 'image'；
//   ② 并排看只接受 2–4 件（第 5 件必须被拒），且切换题目清空选择；
//   ③ 图像作品不生成 preview_url / 走 CoverImg 唯一图片出口（护栏：不许新造 <img> 裸吃 cover_url）。
//
// 说明：并排逻辑与 uiConsistency 同源，直接读源文件断言（组件测试环境的投入产出比不足）。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(import.meta.dirname, '../src')
// 归一 CRLF → LF：断言里写多行片段时不被行尾符绊倒（git autocrlf 让工作区是 CRLF）
const read = (p: string) => readFileSync(path.join(SRC, p), 'utf8').replace(/\r\n/g, '\n')

describe('① 上传向导：image 类型', () => {
  const wizard = read('composables/useUploadWizard.ts')
  const upload = read('views/UploadView.vue')
  const describe_ = read('components/upload/StepDescribe.vue')
  const types = read('api/types.ts')

  it('typeOptions 含 image 卡（作品图片语义）', () => {
    expect(wizard).toContain("value: 'image' as const")
    expect(wizard).toContain('typeImageCard')
  })

  it('UploadView 的 demoType 联合放行 image，且文件 accept 切到图片白名单', () => {
    expect(upload).toContain("ref<'web' | 'zip' | 'link' | 'image'>")
    expect(upload).toContain("image/png,image/jpeg,image/webp")
  })

  it('image 类型下隐藏封面字段（图即作品，不让用户选两次）', () => {
    // StepDescribe 封面 label 带 v-if="demoType !== 'image'"
    expect(describe_).toMatch(/v-if="demoType !== 'image'"/)
    expect(describe_).toContain("'web' | 'zip' | 'link' | 'image'")
  })

  it('types.ts 联合类型均放行 image（题目系统 v2 +1：TaskChainRow.demo_type 随行返回）', () => {
    const hits = types.match(/'web' \| 'zip' \| 'link' \| 'image'/g) ?? []
    expect(hits.length).toBe(4)
  })
})

describe('② 同题并排：2–4 件上限与题目切换', () => {
  const view = read('views/TaskDetailView.vue')

  it('上限常量是 4，且达到上限后新勾选被拒（逻辑拒绝 + 视觉回滚）', () => {
    expect(view).toContain('MAX_SIDE_BY_SIDE = 4')
    expect(view).toContain('pickFull')
    // 到上限时不再加入（早返回分支）
    expect(view).toMatch(/if \(!pickFull\.value\) \{[\s\S]{0,120}return/)
    // 被拒时手动回滚浏览器已打上的勾（否则勾选态与并排件数不一致）
    expect(view).toMatch(/e\.target\.checked = false/)
    // 模板把原生事件传进去
    expect(view).toMatch(/@change="togglePick\(r\.slug, \$event\)"/)
  })

  it('少于 2 件不渲染并排区块', () => {
    expect(view).toContain('canCompare')
    expect(view).toMatch(/pickedRows\.value\.length >= 2/)
  })

  it('切换题目清空选择（不把上一题的 slug 带过来）', () => {
    expect(view).toMatch(/watch\(\(\) => route\.params\.slug, \(\) => \{ pickSlugs\.value = \[\] \}\)/)
  })

  it('并排格子用 CoverImg（唯一图片出口），无图给占位不留空洞', () => {
    expect(view).toContain('sbs-figure-empty')
    // 模板顺序：<CoverImg ... v-if="r.cover_url" />，占位 div 走 v-else
    expect(view).toMatch(/<CoverImg[\s\S]{0,400}v-if="r\.cover_url"[\s\S]{0,400}sbs-figure-empty/)
  })

  it('移动端水平滚动（sbs-scroll 容器 + 窄屏列宽）', () => {
    const css = readFileSync(path.join(SRC, 'styles/pages/task-detail.css'), 'utf8').replace(/\r\n/g, '\n')
    expect(css).toContain('.sbs-scroll { overflow-x: auto;')
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]{0,120}\.sbs-grid \{ grid-auto-columns: 78vw; \}/)
  })
})

describe('③ 图像详情：无 iframe、走唯一图片出口', () => {
  const view = read('views/DemoView.vue')

  it('image 分支在 link 兜底之前插入（否则落到外部链接分支）', () => {
    const iImage = view.indexOf("demo.demo_type === 'image'")
    // link 兜底块的特征串（缩进可能随格式微调，用不含缩进的锚点）
    const iElse = view.indexOf('<div class="card card-coral dv-standin">')
    expect(iImage).toBeGreaterThan(-1)
    expect(iElse).toBeGreaterThan(-1)
    expect(iImage).toBeLessThan(iElse)
  })

  it('图像详情使用 CoverImg tier="full"，不自行拼 <img :src="cover_url">', () => {
    expect(view).toMatch(/<CoverImg[\s\S]{0,200}tier="full"/)
    expect(view).not.toMatch(/<img[^>]*:src="demo\.cover_url"/)
  })

  it('下载按钮按类型分文案（图像=下载图片）', () => {
    expect(view).toContain("t('demo.downloadImage', '下载图片')")
  })

  it('图不裁切（object-fit: contain —— 作品图被裁等于改内容）', () => {
    expect(view).toMatch(/\.dv-image-img \{[\s\S]{0,200}object-fit: contain;/)
  })
})
