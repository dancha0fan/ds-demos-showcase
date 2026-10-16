import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../api'
import type { TagKeyInfo } from '../api/types'

/** 标签键全局缓存：UploadView / TagPicker / TagList / AdminTags 共享，避免重复请求 */
export const useTagsStore = defineStore('tags', () => {
  const keys = ref<TagKeyInfo[]>([])
  const loaded = ref(false)
  const loading = ref(false)

  async function load(force = false) {
    if ((loaded.value && !force) || loading.value) return keys.value
    loading.value = true
    try {
      keys.value = await api.listTagKeys()
      loaded.value = true
    } catch {
      // P-12：失败时**保留既有缓存**。原实现 `keys.value = []` 会把此前成功加载的
      // 词表一并丢掉 —— 上传页标签选择器会瞬间变空，且 store 无 error 状态、静默无感。
      // loaded 不置位 → 下次 load() 仍会重试（失败不该被当成"已加载"）。
    } finally {
      loading.value = false
    }
    return keys.value
  }

  async function refresh() {
    loaded.value = false
    return load(true)
  }

  return { keys, loaded, loading, load, refresh }
})
