<script setup lang="ts">
/**
 * 作品库的 demo 组（同题 ≥2 件）：多张卡堆叠成一个单元，取代原先「整行组头 + 折叠摘要」。
 *
 * 为什么不是整行：组头霸占一行会打断瀑布流，单件作品与组在视觉上被分成两种排版体系。
 * 现在组就是瀑布流里的一个格子（堆叠卡），点一下在当前格位原地展开成组内全部卡片。
 *
 * 收起态的可点区域必须是真 <button>（不是 role=button 的 div/span）：
 * 2026-10 的键盘可达整改把这类假按钮全换成了真按钮，这里沿用同一口径。
 * 展开态里每张卡才恢复成 <RouterLink>，所以不会出现「链接套按钮」。
 */
import { computed } from 'vue'
import type { DemoSummary } from '../api/types'
import type { TaskGroup } from '../utils/demoList'
import { t } from '../i18n'
import CoverImg from './CoverImg.vue'
import DemoCard from './DemoCard.vue'
import MasonryGrid from './MasonryGrid.vue'
import PromptDemoCard from './PromptDemoCard.vue'

const props = defineProps<{
  group: TaskGroup<DemoSummary>
  /** 组的代表件（按当前排序口径取组内最好的一件），渲染在堆叠卡最上层 */
  rep: DemoSummary
  open: boolean
  /** 组是否已取全：true → 组头写「共 N 件」；false → 写「已加载 N 件」（口径不许含糊） */
  complete?: boolean
  /** 单元 key（如 `g:1`）：只用于给展开/收起前后的滚动校正提供稳定的 DOM 锚点。
   *  必须显式接收并绑到根元素 —— 本组件有两个根分支（v-if/v-else），
   *  Vue 不会自动透传非 prop 属性（2026-10-17 实测：`:data-unit-key` 落在组件上直接丢失，
   *  导致收起后的滚动校正变成空操作、页面被浏览器钳到瀑布流底部）。 */
  unitKey?: string
  /** 提示词模式：展开后渲染 PromptDemoCard 而不是 DemoCard */
  promptMode?: boolean
}>()

const emit = defineEmits<{ toggle: [] }>()

/** 按码点取首字：title[0] 遇到 emoji 开头只拿到半个代理对（DemoCard 同款处理） */
const initial = computed(() => Array.from(props.rep.title)[0] ?? '')

const countLabel = computed(() =>
  props.complete
    ? t('demos.tgTotal', '共 {n} 件', { n: props.group.items.length })
    : t('demos.tgCount', '已加载 {n} 件', { n: props.group.items.length }),
)
</script>

<template>
  <!-- 展开态：在当前格位铺开组内全部卡片（不跳页、不弹层） -->
  <section v-if="open" class="dgs dgs--open" :data-unit-key="unitKey">
    <div class="dgs-head">
      <span class="dgs-head-main">
        <span class="dgs-task">{{ group.task?.title }}</span>
        <span class="dgs-count">{{ countLabel }}</span>
      </span>
      <span class="dgs-head-actions">
        <RouterLink v-if="group.task" class="dgs-link" :to="`/tasks/${group.task.slug}`">
          {{ t('demos.tgOpen', '题目页 →') }}
        </RouterLink>
        <button class="dgs-toggle" type="button" :aria-expanded="true" @click="emit('toggle')">
          {{ t('demos.tgCollapse', '收起') }}
        </button>
      </span>
    </div>
    <div class="dgs-cards">
      <!-- 跨满整行后，组内自己排多列：内部也是一个瀑布流，卡片按列均摊，不再一条竖线拉到很长 -->
      <MasonryGrid
        :items="group.items"
        :item-key="(d: unknown) => (d as DemoSummary).slug"
        :min-col-width="220"
        :gap="16"
      >
        <template #default="{ item }">
          <PromptDemoCard v-if="promptMode" :demo="item as DemoSummary" />
          <DemoCard v-else :demo="item as DemoSummary" />
        </template>
      </MasonryGrid>
    </div>
  </section>

  <!-- 收起态：两张错位的底层卡 + 最上层代表件；整块是一个真按钮 -->
  <div v-else class="dgs dgs--stack" :data-unit-key="unitKey">
    <span class="dgs-layer dgs-layer--2" aria-hidden="true"></span>
    <span class="dgs-layer dgs-layer--1" aria-hidden="true"></span>
    <button
      class="card card-hover b-lift dgs-face"
      data-reset
      type="button"
      :aria-expanded="false"
      :aria-label="`${group.task?.title ?? ''} · ${t('demos.tgExpand', '展开查看全部')}`"
      @click="emit('toggle')"
    >
      <span class="dgs-cover">
        <CoverImg
          v-if="rep.cover_url"
          :src="rep.cover_url"
          tier="card"
          sizes="(max-width:720px) 45vw, 320px"
          :alt="rep.title"
        />
        <span v-else class="dgs-cover-fallback" aria-hidden="true">{{ initial }}</span>
      </span>
      <span class="dgs-body">
        <span class="dgs-task">{{ group.task?.title }}</span>
        <span class="dgs-title">{{ rep.title }}</span>
        <span class="dgs-meta">
          <span class="dgs-count">{{ countLabel }}</span>
          <span class="dgs-hint">{{ t('demos.tgExpand', '展开查看全部') }}</span>
        </span>
      </span>
    </button>
  </div>
</template>

<style scoped>
/* 结构样式只写「盒模型 / 排版」，hover/active 物理一律交给微交互库（.b-lift）——
   门禁 ② 禁止在 lift.css 之外写交互物理。 */
.dgs {
  position: relative;
}

/* ---------- 收起态：堆叠 ---------- */
.dgs-layer {
  position: absolute;
  inset: 0;
  background: var(--paper);
  border: var(--border-w-sm) solid var(--ink);
  /* 底层卡只是「还有几张」的视觉提示，不接收事件，也不进无障碍树 */
  pointer-events: none;
}
/* 位移用独立的 translate 属性（接受空格分隔值）——不要写成 translate(...) 函数塞令牌 */
.dgs-layer--1 {
  translate: var(--sp-4) var(--sp-4);
}
.dgs-layer--2 {
  translate: var(--sp-8) var(--sp-8);
}

.dgs-face {
  position: relative;
  /* 层序走令牌（门禁：不许裸 z-index 数字）；底层卡是 z-index:auto，天然在下方 */
  z-index: var(--z-local);
  display: block;
  width: 100%;
  padding: 0;
  text-align: left;
  color: var(--ink);
  font: inherit;
  cursor: pointer;
}

.dgs-cover {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 4 / 3;
  border-bottom: var(--border-w) solid var(--ink);
  overflow: hidden;
}
.dgs-cover-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-family: var(--font-heading);
  font-weight: 900;
  font-size: var(--fs-32);
  color: var(--ink);
  text-shadow: 3px 3px 0 var(--ink);
  background: var(--wash-mint);
}

.dgs-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
  padding: var(--sp-14) var(--sp-16) var(--sp-16);
}

/* 组名（题目）：眉标位 —— 与卡片标题区分开 */
.dgs-task {
  font-family: var(--font-body);
  font-size: var(--fs-11);
  font-weight: 800;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--ink-soft);
}
.dgs-title {
  font-family: var(--font-heading);
  font-weight: 900;
  font-size: var(--fs-18);
  line-height: 1.1;
  text-transform: uppercase;
}
.dgs-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-8);
  font-size: var(--fs-11);
  color: var(--ink-soft);
}
.dgs-count {
  font-weight: 800;
  color: var(--ink);
}
.dgs-hint {
  text-decoration: underline;
}

/* ---------- 展开态：组内全部卡片 ---------- */
.dgs--open {
  border: var(--border-w-sm) dashed var(--ink);
  padding: var(--sp-10);
  background: var(--paper-deep, var(--paper));
}
.dgs-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-8);
  padding-bottom: var(--sp-10);
  border-bottom: var(--border-w-sm) solid var(--ink);
  margin-bottom: var(--sp-10);
}
.dgs-head-main {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--sp-8);
  min-width: 0;
}
.dgs-head-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-8);
}
.dgs-link {
  font-size: var(--fs-11);
  font-weight: 700;
  color: var(--ink);
}
.dgs-toggle {
  font-size: var(--fs-11);
  font-weight: 800;
  padding: var(--sp-2) var(--sp-10);
  background: var(--paper);
  color: var(--ink);
  border: var(--border-w-sm) solid var(--ink);
  cursor: pointer;
}
.dgs-cards {
  /* 组内是内部瀑布流（跨整行后自己排多列），这里只负责把网格铺满整行 */
  display: block;
}
</style>
