import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../api'
import type { User } from '../api/types'

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const loading = ref(false)
  /**
   * 登录态是否已经确认过（探测完成，或经由 login/register/logout 明确设定）。
   * 匿名访客的 user 永远是 null —— 若用 `user === null` 判断"要不要探测"，
   * 每次站内跳转都会先阻塞一趟 GET /auth/me（401）再放行，换页时延 = 一次往返。
   */
  const checked = ref(false)
  let probing: Promise<User | null> | null = null

  const isLoggedIn = () => !!user.value
  const isAdmin = () => user.value?.role === 'admin'

  async function fetchMe() {
    try {
      user.value = await api.me()
    } catch {
      user.value = null
    }
    checked.value = true
    return user.value
  }

  /** 只在首次需要时探测；并发调用共用同一个请求 */
  function ensureChecked(): Promise<User | null> {
    if (checked.value) return Promise.resolve(user.value)
    probing ??= fetchMe().finally(() => {
      probing = null
    })
    return probing
  }

  async function login(username: string, password: string) {
    loading.value = true
    try {
      const res = await api.login(username, password)
      user.value = res.user
      checked.value = true
      return res.user
    } finally {
      loading.value = false
    }
  }

  async function register(username: string, password: string) {
    loading.value = true
    try {
      const res = await api.register(username, password)
      user.value = res.user
      checked.value = true
      return res.user
    } finally {
      loading.value = false
    }
  }

  /**
   * 直接用接口返回值更新本地 user（不必再 fetchMe 一趟）。
   * 为什么必须有：PATCH /auth/me、上传/移除头像、切换隐私开关都返回新的 user，
   * 而 store 原先只有 fetchMe/login/register/logout —— 改完 UI 不会变，用户会以为没生效。
   */
  function setUser(u: User | null) {
    user.value = u
  }

  async function logout() {
    try {
      await api.logout()
    } finally {
      user.value = null
      checked.value = true
    }
  }

  return { user, loading, checked, isLoggedIn, isAdmin, fetchMe, ensureChecked, login, register, logout, setUser }
})
