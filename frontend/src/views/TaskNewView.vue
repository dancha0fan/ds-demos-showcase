<script setup lang="ts">
// 独立出题（题目与作品创建解耦）：不依赖上传作品，直接提一道题。
// 审核语义与上传页「提议新题」完全一致：落待审收件箱，管理员批准才公开（不直建题目）。
defineOptions({ name: 'TaskNewView' })
import { ref } from 'vue'
import { api } from '../api'
import { t } from '../i18n'
import PageHero from '../components/PageHero.vue'

const title = ref('')
const description = ref('')
const category = ref('')
const submitting = ref(false)
const error = ref('')
/** 提交受理结果（duplicate=true = 同题名提案已在队列，幂等返回） */
const accepted = ref<{ duplicate: boolean } | null>(null)

async function submit() {
  if (submitting.value) return
  const titleTrim = title.value.trim()
  if (!titleTrim) {
    error.value = t('taskNew.titleRequired', '题名必填')
    return
  }
  submitting.value = true
  error.value = ''
  try {
    const res = await api.proposeTask({
      title: titleTrim,
      description: description.value.trim(),
      category: category.value.trim() || null,
    })
    accepted.value = { duplicate: res.duplicate }
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    submitting.value = false
  }
}

function again() {
  accepted.value = null
  title.value = ''
  description.value = ''
  category.value = ''
  error.value = ''
}
</script>

<template>
  <div class="route-page">
    <PageHero>
      <span class="eyebrow">{{ t('tasks.eyebrow', '题目图鉴') }}</span>
      <h1 class="page-title">{{ t('taskNew.title', '出一道题') }}</h1>
      <p class="sub">{{ t('taskNew.sub', '题目不再只能是作品的附属品 —— 先立题，作品可以之后由你或别人挂上来。') }}</p>
    </PageHero>

    <section class="section" style="padding-top: var(--sp-8)">
      <!-- 受理成功：进审核队列（与上传提议新题同一收件箱） -->
      <div v-if="accepted" class="card card-default tn-done">
        <p class="tn-done-head">
          {{ accepted.duplicate
            ? t('taskNew.dupOk', '这道题你已提交过，仍在审核队列中 —— 无需重复提交。')
            : t('taskNew.ok', '已提交，进入审核队列。管理员批准后题目即公开。') }}
        </p>
        <p class="muted tn-done-note">{{ t('taskNew.okNote', '批准后别人（包括你）可以在上传时用「挑战此题」把作品挂上来。') }}</p>
        <div class="filter-row tn-done-actions">
          <RouterLink class="btn btn-sm btn-primary" to="/tasks">{{ t('tasks.title', '题目') }}</RouterLink>
          <button class="btn btn-sm btn-secondary" type="button" @click="again">{{ t('taskNew.again', '再出一题') }}</button>
        </div>
      </div>

      <form v-else class="card card-default tn-form" @submit.prevent="submit">
        <label class="tn-label">
          <span class="tn-label-text">{{ t('taskNew.fieldTitle', '题名') }} <b class="tn-req">*</b></span>
          <input v-model="title" class="input" type="text" maxlength="200" required
            :placeholder="t('taskNew.phTitle', '例：只用电量条通关的贪吃蛇')" />
        </label>
        <label class="tn-label">
          <span class="tn-label-text">{{ t('taskNew.fieldBrief', '题面') }}</span>
          <textarea v-model="description" class="input" rows="5" maxlength="4000"
            :placeholder="t('taskNew.phBrief', '这道题到底让做什么：目标、约束、评判口径。写清楚，同题对比才成立。')"></textarea>
        </label>
        <label class="tn-label">
          <span class="tn-label-text">{{ t('taskNew.fieldCategory', '分类（可选）') }}</span>
          <input v-model="category" class="input" type="text" maxlength="64"
            :placeholder="t('taskNew.phCategory', '游戏 / 工具 / 效果…')" />
        </label>

        <p v-if="error" class="notice notice-error">{{ error }}</p>
        <div class="filter-row tn-actions">
          <button class="btn btn-primary" type="submit" :disabled="submitting">
            {{ submitting ? t('taskNew.submitting', '提交中…') : t('taskNew.submit', '提交审核') }}
          </button>
          <RouterLink class="btn btn-secondary" to="/tasks">{{ t('common.cancel', '取消') }}</RouterLink>
        </div>
        <p class="muted tn-note">{{ t('taskNew.rule', '出题需登录；提交后进入待审队列，不公开前不影响任何人。审核口径与上传提议新题一致。') }}</p>
      </form>
    </section>
  </div>
</template>

<style scoped>
/* 独立出题表单（styles/ 冻结令：新样式全 scoped，令牌带字面回落） */
.tn-form {
  max-width: 720px;
  display: grid;
  gap: var(--sp-16);
}
.tn-label {
  display: grid;
  gap: var(--sp-6);
}
.tn-label-text {
  font-weight: 900;
  font-size: var(--fs-13);
}
.tn-req {
  color: var(--red, #ff6b6b);
}
textarea.input {
  resize: vertical;
  min-height: 120px;
}
.tn-actions {
  margin: 0;
}
.tn-note {
  font-size: var(--fs-12);
  margin: 0;
}
.tn-done {
  max-width: 720px;
  display: grid;
  gap: var(--sp-10);
}
.tn-done-head {
  font-family: var(--font-heading, sans-serif);
  font-weight: 900;
  font-size: var(--fs-16);
  margin: 0;
}
.tn-done-note {
  font-size: var(--fs-13);
  margin: 0;
}
.tn-done-actions {
  margin: 0;
}
</style>
