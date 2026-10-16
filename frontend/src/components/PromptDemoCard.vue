<script setup lang="ts">
import { ref } from 'vue'
import { useUiStore } from '../stores/ui'
import type { DemoSummary } from '../api/types'
import { t } from '../i18n'
import CoverImg from '../components/CoverImg.vue'

const props = defineProps<{ demo: DemoSummary }>()
const ui = useUiStore()

const expanded = ref(false)
const prompt = props.demo.prompt?.trim() || ''
const showToggle = prompt.length > 60
const initial = Array.from(props.demo.title)[0] ?? ''

async function copyPrompt() {
  try {
    await navigator.clipboard.writeText(prompt)
    ui.toast(t('copy.promptDone', '提示词已复制'), 'success')
  } catch {
    ui.toast(t('copy.failed', '复制失败，请手动选择复制'), 'error')
  }
}
</script>

<template>
  <div class="card prompt-card">
    <div class="prompt-block" :class="{ expanded }">
      <button
        v-if="prompt"
        class="prompt-copy"
        type="button"
        :title="t('copy.promptTitle', '复制提示词')"
        @click="copyPrompt"
      >{{ t('copy.copy', '复制') }}</button>
      <p v-if="prompt" class="prompt-text" :class="{ clamp: !expanded }">{{ prompt }}</p>
      <p v-else class="prompt-text prompt-empty">{{ t('card.noPrompt', '无提示词') }}</p>
      <button
        v-if="prompt && showToggle"
        class="prompt-toggle"
        type="button"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >{{ expanded ? t('demos.collapse', '收起') : t('demos.expand', '展开') }}</button>
    </div>

    <RouterLink :to="`/demo/${demo.slug}`" class="prompt-body">
      <h3 class="prompt-title">{{ demo.title }}</h3>
      <div class="prompt-cover">
        <CoverImg v-if="demo.cover_url" :src="demo.cover_url" tier="card" sizes="(max-width:720px) 100vw, 260px" :alt="demo.title" />
        <div v-else class="cover-fallback" style="background: var(--wash-mint, #4ecdc4)">{{ initial }}</div>
      </div>
    </RouterLink>
  </div>
</template>
