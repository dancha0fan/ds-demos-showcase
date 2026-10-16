<script setup lang="ts">
import { computed, ref } from 'vue'
import type { DemoSummary } from '../api/types'
import { tagLabel } from '../utils/funMode'
import { keyLabel, t } from '../i18n'
import ModelChips from './ModelChips.vue'
import CoverImg from '../components/CoverImg.vue'

const props = defineProps<{ demo: DemoSummary }>()

const cover = computed(() => props.demo.cover_url)
/** 按码点取首字：title[0] 遇到 emoji 开头只拿到半个代理对，渲染成 □ */
const initial = computed(() => Array.from(props.demo.title)[0] ?? '')
// 封面加载失败（文件缺失/迁移中）时退回色块首字，不留白框 —— 截图里看到过一片空白卡片
const coverBroken = ref(false)
function onCoverError() {
  coverBroken.value = true
}

/** v2：有实体数据时模型走 ModelChips 一等展示，标签行不再重复 model 键 */
const showModelChips = computed(() => !!props.demo.models?.length)

const statLabels: Record<string, string> = {
  model: '模型',
  type: '类型',
  skills: '技能',
  plugin: '插件',
  preset: '预设',
  author: '作者',
}

function label(tag: { key: string; value: string }) {
  // 整活模式：仅显示文案走 tagLabel；:key/路由/复制仍用原始值。键 label 走 i18n（EN → Model/Type…）
  const v = tagLabel(tag.value)
  return `${keyLabel(tag.key, statLabels[tag.key])}:${v}`
}
</script>

<template>
  <RouterLink :to="`/demo/${demo.slug}`" class="card card-hover demo-card animate-in b-lift">
    <div class="demo-cover">
      <CoverImg v-if="cover && !coverBroken" :src="cover" tier="card" sizes="(max-width:720px) 50vw, 320px" :alt="demo.title" @error="onCoverError" />
      <div v-else class="cover-fallback" style="background: var(--wash-mint, #4ecdc4)">{{ initial }}</div>
    </div>
    <div class="demo-card-body">
      <h3 class="demo-title">{{ demo.title }}</h3>
      <p v-if="demo.description" class="demo-meta demo-desc">{{ demo.description }}</p>
      <!-- v2：卡片上的模型是"署名"（轻 chip、无印章），层级让位于标题；档案级印章留给详情页/模型页 -->
      <div v-if="showModelChips" class="demo-byline">
        <ModelChips :models="demo.models ?? []" :max="2" size="sm" plain prefix />
      </div>
      <div class="filter-row" style="margin-bottom: var(--sp-10)">
        <span
          v-for="t in demo.tags.filter((x) => x.key !== 'author' && (x.key !== 'model' || !showModelChips)).slice(0, 3)"
          :key="t.key + ':' + t.value"
          class="tag-chip"
          :class="t.key === 'model' ? 'teal' : t.key === 'type' ? 'red' : ''"
        >
          {{ label(t) }}
        </span>
      </div>
      <div class="demo-stats">
        <!-- M0-C 分数+样本档成对（03 §5.2）：n≥5 显示 ★均分 · n=N；n<5 灰显分数主体只给「样本不足」——
             n<5 的均值是噪声，不给结论（红线：样本不足不许伪装成有效口碑） -->
        <span v-if="demo.rating_count" class="stat rate-pair" :class="{ 'rate-low': demo.rating_count < 5 }">
          <svg v-if="demo.rating_count >= 5" class="rate-star" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 1l2 4.4 4.8.5-3.6 3.2 1 4.7L8 11.4 3.8 13.8l1-4.7L1.2 5.9 6 5.4z" fill="var(--yellow, #ffe66d)" stroke="var(--ink, #000)" stroke-width="1.2" />
          </svg>
          <template v-if="demo.rating_count >= 5">{{ Number(demo.rating_avg || 0).toFixed(1) }} · n={{ demo.rating_count }}</template>
          <template v-else>{{ t('card.sampleLow', '样本不足') }} · n={{ demo.rating_count }}</template>
        </span>
        <!-- P6：计数是统计不是行动 —— 纸底黑边，不用黄/青/红底 -->
        <span class="stat" :title="t('demo.views', '浏览')">
          <svg class="stat-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" /><circle cx="8" cy="8" r="2" /></svg>
          <span class="sr-only">{{ t('demo.views', '浏览') }}</span>{{ demo.view_count }}
        </span>
        <span class="stat" :title="t('demo.downloads', '下载')">
          <svg class="stat-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 13.5h11" /></svg>
          <span class="sr-only">{{ t('demo.downloads', '下载') }}</span>{{ demo.download_count }}
        </span>
        <span class="stat" :title="t('demo.discussions', '讨论')">
          <svg class="stat-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2.5h12v8.5H7l-3.5 3v-3H2Z" /></svg>
          <span class="sr-only">{{ t('demo.discussions', '讨论') }}</span>{{ demo.comment_count }}
        </span>
      </div>
    </div>
  </RouterLink>
</template>

<style scoped>
/* M0-C 分数+样本档成对（组件级样式；全局 style.css 冻结——P1 拆迁后并入语义 token 体系） */
.rate-pair {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-4);
  white-space: nowrap;
}
.rate-star {
  width: 12px;
  height: 12px;
  flex: none;
}
.stat-ico {
  width: 12px;
  height: 12px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linejoin: round;
}
/* 按行截断而不是按字数：中英文同样两行、带省略号 */
.demo-desc {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
}
/* n<5：灰显分数主体（覆盖 stat-mint 的彩色底——信息降级必须看得见） */
.rate-pair.rate-low {
  color: var(--ink-soft, #555);
  background: var(--paper-deep, #f2eee6);
  border-color: var(--ink-soft, #555);
}
</style>
