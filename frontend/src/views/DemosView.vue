<script setup lang="ts">
defineOptions({ name: 'DemosView' })
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave, useRoute } from 'vue-router'
import { api } from '../api'
import { useLoadGeneration } from '../composables/useLoadGeneration'
import type { DemoSummary, TagKeyInfo } from '../api/types'
import { tagLabel } from '../utils/funMode'
import { guessVendor } from '../utils/tagGroups'
import { chipLabel, intBounds, intBoundsOf, quickPresets, vendorDot } from '../utils/demoFacets'
import { buildUnits, dedupeBySlug, type ListUnit, type UnitSortMode } from '../utils/demoList'
import { useDemoFilters } from '../composables/useDemoFilters'
import { useFacetDrawer } from '../composables/useFacetDrawer'
import type { QuickPreset } from '../utils/demoFacets'
import { t, keyLabel, vendorLabel } from '../i18n'
import { isImeComposing } from '../utils/ime'
import DemoCard from '../components/DemoCard.vue'
import DemoGroupStack from '../components/DemoGroupStack.vue'
import EmptyBox from '../components/EmptyBox.vue'
import MasonryGrid from '../components/MasonryGrid.vue'
import PromptDemoCard from '../components/PromptDemoCard.vue'
import RangeSlider from '../components/RangeSlider.vue'
import TagTip from '../components/TagTip.vue'
import PageHero from '../components/PageHero.vue'

const demos = ref<DemoSummary[]>([])
const tagKeys = ref<TagKeyInfo[]>([])
const route = useRoute()

// URL ?task=<slug>：题目域浏览（如题目页「查看本题全部作品」链过来）。
// 双重语义：既作为列表过滤条件透传给后端，也作为同题分组的归属优先项
//（多题作品优先归入当前筛选题，分组语义与筛选语义一致）。
const preferTaskSlug = computed(() => {
  const v = route.query.task
  return typeof v === 'string' && v.trim() ? v.trim() : ''
})

// RF-4e：筛选状态 + URL 双向同步抽到 useDemoFilters（可单测；onChange 即原来的 reset()）
const {
  selectedTags,
  q,
  submittedQ,
  modelFilter,
  sort,
  cardMode,
  intRange,
  facetCount,
  syncQuery,
  applyRouteQuery,
  apply: applyFilters,
  setCardMode,
  initIntRanges,
} = useDemoFilters({ onChange: () => reset() })


const page = ref(1)
const pageSize = 12
const total = ref(0)
const loading = ref(false)
const loadingMore = ref(false)
const refreshing = ref(false)
const error = ref('')
const hasMore = ref(true)

// ---------- 同题 demo 组（堆叠卡单元）----------
// 分组数据层在 utils/demoList（纯函数可单测）：分组键 = 题目 id（列表接口随作品返回），
// 不按标题猜同题。一个组在瀑布流里占**一个格子**（堆叠卡），不再用整行组头。
// 组级排序口径：时间=组内最近更新、热度=组内浏览最多、评分=组内最高分。
const TG_PREF_KEY = 'demos.taskGroup'
const taskGroupOn = ref(readTgPref())
function readTgPref(): boolean {
  try {
    return localStorage.getItem(TG_PREF_KEY) !== '0'
  } catch {
    return true
  }
}
function setTaskGroup(on: boolean) {
  taskGroupOn.value = on
  try {
    localStorage.setItem(TG_PREF_KEY, on ? '1' : '0')
  } catch {
    /* 隐私模式等存储不可用：仅本会话生效 */
  }
}
/**
 * 当前排序 → 组级排序口径：
 * - 最新：组内**最近更新**的那一件（Demo.updated_at，只在内容被改时变）
 * - 最热：组内**浏览最多**的那一件
 * - 评分：组内**最高分**的那一件（rating 入口暂未接，规则先备好）
 * - 随机 / 提示词模式：`none` —— 服务端顺序必须原样保留，客户端不许重排
 */
const unitSort = computed<UnitSortMode>(() => {
  if (cardMode.value === 'prompt') return 'none'
  const s = String(sort.value)
  if (s === 'newest' || s === 'popular' || s === 'rating') return s
  return 'none'
})
/** 瀑布流的渲染单元：一件作品，或一个同题组（堆叠卡） */
const units = computed(() => {
  // 组内全量：已加载切片里出现的题目，补上该题的全部作品（组一出现就整组可见）
  const pool = [...demos.value]
  if (taskGroupOn.value && groupMembers.value.size) {
    const seen = new Set(pool.map((d) => d.slug))
    for (const list of groupMembers.value.values()) {
      for (const d of list) {
        if (seen.has(d.slug)) continue
        seen.add(d.slug)
        pool.push(d)
      }
    }
  }
  return buildUnits(pool, { preferTaskSlug: preferTaskSlug.value || undefined, sort: unitSort.value })
})
// 展开态按单元 key 记忆；换筛选（reset）清空——旧展开态对新数据集没有意义
const tgOpen = ref<Record<string, boolean>>({})
function isUnitOpen(u: ListUnit<DemoSummary>) {
  return u.kind === 'group' && !!tgOpen.value[u.key]
}
/**
 * 展开 / 收起。
 *
 * 收起会把一个很高的整行块换回一个堆叠卡 —— 页面瞬间变矮，浏览器会把 scrollY
 * 钳到新的最大滚动位置，看起来就是「点了收起直接跳到瀑布流最后」。
 * 所以切换前后各量一次该单元的视口位置，差多少就 scrollBy 多少，把它按回原处。
 * （展开时这段通常是 no-op：块在原地向下长高。）
 */
async function toggleUnit(u: ListUnit<DemoSummary>) {
  const sel = `[data-unit-key="${u.key}"]`
  const beforeTop = document.querySelector<HTMLElement>(sel)?.getBoundingClientRect().top ?? 0
  tgOpen.value = { ...tgOpen.value, [u.key]: !isUnitOpen(u) }
  await nextTick()
  const correct = () => {
    const el = document.querySelector<HTMLElement>(sel)
    if (!el) return
    const delta = el.getBoundingClientRect().top - beforeTop
    if (Math.abs(delta) > 1) window.scrollBy(0, delta)
  }
  correct()
  // 瀑布流会在接下来的几帧里用实测高度收敛（MasonryGrid 首帧按估算高度排、再 settle），
  // 位置还会挪几次；连校 6 帧（≈100ms）把它按住，之后用户自己滚就不再干预。
  let n = 0
  const tick = () => {
    correct()
    if (++n < 6) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

// 模板里对槽位 item 做窄化的小工具（MasonryGrid 的 item 是 unknown）
function isGroupUnit(item: unknown): boolean {
  return (item as ListUnit<DemoSummary>).kind === 'group'
}
function groupOf(item: unknown) {
  return item as Extract<ListUnit<DemoSummary>, { kind: 'group' }>
}
function demoOf(item: unknown): DemoSummary {
  return (item as Extract<ListUnit<DemoSummary>, { kind: 'demo' }>).demo
}

// ---------- 组内全量（「组一出现就必须整组可见」）----------
// 主列表按页切片，一个同题组会被页边界切开。所以每加载一页，就把该页出现的题目
// 批量补全（GET /demos/by-tasks）；组渲染用「已加载切片 + 补全的整组成员」。
const groupMembers = ref<Map<number, DemoSummary[]>>(new Map())
const groupFetched = new Set<number>()
let groupEpoch = 0

async function ensureGroupMembers(items: readonly DemoSummary[]) {
  const want = new Set<number>()
  for (const d of items) for (const t of d.tasks ?? []) if (!groupFetched.has(t.id)) want.add(t.id)
  if (!want.size) return
  const ids = [...want].slice(0, 20) // 单页最多补 20 个题（与后端上限一致）
  for (const id of ids) groupFetched.add(id) // 先占位：并发/连翻不会重复请求同一题
  const epoch = groupEpoch
  try {
    const rows = await api.demosByTasks(ids)
    // 只受数据集世代（换筛选 reset 时 ++）约束：整组成员与「第几页/第几次请求」无关。
    // 不能再用 gen.isCurrent(my) —— 无限滚动紧接着发的「加载更多」会推进世代号，
    // 把第 1 页这次补全的响应判成过期丢掉（实测：组永远停在「已加载」）。
    if (epoch !== groupEpoch) return
    const next = new Map(groupMembers.value)
    for (const id of ids) next.set(id, rows.filter((r) => (r.tasks ?? []).some((t) => t.id === id)))
    groupMembers.value = next
  } catch {
    // 补全失败：退化为「已加载切片」分组（不阻塞主列表），下次分页再试
    for (const id of ids) groupFetched.delete(id)
  }
}

/** 组是否已取全（决定组头写「N 件」还是「已加载 N 件」——口径不许含糊） */
function isGroupComplete(key: number | null): boolean {
  return key !== null && groupMembers.value.has(key)
}

/**
 * 渲染块：连续的普通单元 → 一个瀑布流段；**展开的组 → 跨满整行的一块**。
 * 展开的组不能留在瀑布流里（留在里面只能占一列，会把那一列拉得很长），
 * 所以把它从流中取出，作为整行块插在它原来的排序位置上。
 */
type RenderBlock =
  | { kind: 'grid'; key: string; units: ListUnit<DemoSummary>[] }
  | { kind: 'group'; key: string; unit: Extract<ListUnit<DemoSummary>, { kind: 'group' }> }

const blocks = computed<RenderBlock[]>(() => {
  const out: RenderBlock[] = []
  let run: ListUnit<DemoSummary>[] = []
  const flush = () => {
    if (!run.length) return
    out.push({ kind: 'grid', key: `grid:${run[0].key}`, units: run })
    run = []
  }
  for (const u of units.value) {
    if (u.kind === 'group' && isUnitOpen(u)) {
      flush()
      out.push({ kind: 'group', key: u.key, unit: u })
    } else {
      run.push(u)
    }
  }
  flush()
  return out
})


// ---------- 返回恢复：离开时记录已加载页数与滚动位，回来先补齐深度再落点 ----------
// 路由 savedPosition 只在内容够高时有效，而本页重挂载只会拉第 1 页 —— 不补深度，
// 返回时永远被钳在第 1 页底部（无限滚动经典回退坑）。快照按 query 签名匹配，换筛选不误恢复。
// 随机种子（rs）与分组展开态（tg）一并保存：返回后同一段浏览继续同一次洗牌、组开合不变。
const randomSeed = ref('')
const DEPTH_KEY = 'demos.depth.v2'
const DEPTH_MAX_PAGES = 20
type DepthSnapshot = { sig: string; pages: number; y: number; rs?: string; tg?: Record<string, boolean> }
function depthSig() {
  return window.location.search
}
function saveDepthSnapshot() {
  try {
    const pages = page.value - 1 // page 指向「下一页」，已加载页数 = page-1
    if (pages >= 1 && demos.value.length) {
      sessionStorage.setItem(
        DEPTH_KEY,
        JSON.stringify({ sig: depthSig(), pages, y: window.scrollY, rs: randomSeed.value || undefined, tg: tgOpen.value }),
      )
    } else {
      sessionStorage.removeItem(DEPTH_KEY)
    }
  } catch {
    /* sessionStorage 不可用（隐私模式）：放弃恢复，不影响浏览 */
  }
}
function readDepthSnapshot(): DepthSnapshot | null {
  try {
    const raw = sessionStorage.getItem(DEPTH_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as DepthSnapshot
    return s && typeof s.sig === 'string' && s.pages >= 1 ? s : null
  } catch {
    return null
  }
}
onBeforeRouteLeave(() => {
  saveDepthSnapshot()
})

type FilterGroup = {
  key: string
  mode: 'fixed' | 'open' | 'int'
  label: string
  total: number
  min?: number | null
  max?: number | null
  values: { value: string; count: number; description?: string }[]
}

// 分组筛选（A）：按标签键分行，组内 values 按热度排序
const filterGroups = computed<FilterGroup[]>(() =>
  [...tagKeys.value]
    .filter((k) => k.values.some((v) => v.demo_count > 0))
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.key.localeCompare(b.key))
    .map((k) => ({
      key: k.key,
      mode: k.mode,
      label: k.label || k.key,
      total: k.values.reduce((n, v) => n + v.demo_count, 0),
      min: k.min,
      max: k.max,
      values: [...k.values]
        .filter((v) => v.demo_count > 0)
        .sort((a, b) => b.demo_count - a.demo_count)
        .map((v) => ({ value: v.value, count: v.demo_count, description: v.description })),
    })),
)

// 热门快捷（B）：全站计数最高的 6 个标签值
const hotChips = computed(() =>
  tagKeys.value
    .flatMap((k) => k.values.map((v) => ({ key: k.key, value: v.value, count: v.demo_count, mode: k.mode })))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6),
)

// 折叠态：缺省全部折叠（细条只露前 4 个值），显式展开记录在 expanded
const COLLAPSED_SHOW = 4
const groupExpanded = ref<Record<string, boolean>>({})
function isExpanded(k: FilterGroup) {
  // 默认全部折叠（含 model）
  return groupExpanded.value[k.key] ?? false
}
function isCollapsed(k: FilterGroup) {
  return !isExpanded(k)
}
function toggleGroup(k: FilterGroup) {
  // 写入「与当前相反的展开态」：折叠→置 true 展开，展开→置 false 折叠
  groupExpanded.value = { ...groupExpanded.value, [k.key]: !isExpanded(k) }
}
function visibleValues(k: FilterGroup) {
  return isCollapsed(k) ? k.values.slice(0, COLLAPSED_SHOW) : k.values
}
function hiddenCount(k: FilterGroup) {
  return isCollapsed(k) ? Math.max(0, k.values.length - COLLAPSED_SHOW) : 0
}

// model 厂商分组：RF-4d 改用 utils/tagGroups 的共享实现
// （原先是与 TagPicker 逐字重复的一份 16 行前缀表，加厂商必须同时改两处）
function vendorGroupsOf(k: FilterGroup) {
  const map = new Map<string, { value: string; count: number; description?: string }[]>()
  for (const v of k.values) {
    const g = guessVendor(v.value)
    if (!map.has(g)) map.set(g, [])
    map.get(g)!.push(v)
  }
  return [...map.entries()].map(([group, values]) => ({ group, values }))
}
const vendorExpanded = ref<Record<string, boolean>>({})
function isVendorCollapsed(group: string) {
  return vendorExpanded.value[group] === true
}
function toggleVendor(group: string) {
  vendorExpanded.value = { ...vendorExpanded.value, [group]: !isVendorCollapsed(group) }
}

// ---------- M1-A 分面抽屉（03 §4.2）：筛选收起为按钮 / 抽屉可钉住 / 移动 bottom-sheet ----------
// 形态：桌面 overlay（可钉住转常驻侧栏，localStorage 记忆）/ 移动（≤720）bottom-sheet
// （单组展开、应用即收、抽屉头「已选 N」）。钉住布局切换 0ms 硬切（t22/t23 口径：列宽
// 变化不做补间）；浮层/抽屉出场 stamp-in 微档、关闭 0ms 对称（03 §12.5 弹层语汇）。
// RF-4i：形态层（模式判定/开合/钉住持久化/Esc）抽到 useFacetDrawer；分组内容留在本视图。
const panelEl = ref<HTMLElement | null>(null)
const { isMobile, panelMode, showPanel, backdropActive, closeFacet, toggleFacet, pinFacet, unpinFacet } = useFacetDrawer({
  panelEl,
  onOpen: () => {
    // 移动端单组展开：进入 sheet 时收敛到恰好一组（无开着的组则落回模型组；米勒：一屏一事）。
    // 必须显式写 false——缺席键会回落「默认开」，光写一个 true 压不住其他组
    if (!isMobile.value) return
    const firstOpen = panelGroups.value.find((g) => isPanelOpen(g))?.group.key ?? 'model'
    const next: Record<string, boolean> = {}
    for (const g of panelGroups.value) next[g.group.key] = g.group.key === firstOpen
    panelOpen.value = next
  },
})

// 抽屉分面组序（03 §4.2）：模型置顶（厂商折叠）→ type/category/game → 技术键（可搜索）→ 数值键
type PanelEntry = { kind: 'model' | 'label' | 'tech' | 'int'; group: FilterGroup }
const LABEL_KEYS = ['type', 'category', 'game']
const panelGroups = computed<PanelEntry[]>(() => {
  const byKey = new Map(filterGroups.value.map((g) => [g.key, g]))
  const out: PanelEntry[] = []
  if (byKey.has('model')) out.push({ kind: 'model', group: byKey.get('model')! })
  for (const lk of LABEL_KEYS) if (byKey.has(lk)) out.push({ kind: 'label', group: byKey.get(lk)! })
  for (const g of filterGroups.value) {
    if (g.mode === 'int' || g.key === 'model' || LABEL_KEYS.includes(g.key)) continue
    out.push({ kind: 'tech', group: g })
  }
  for (const g of filterGroups.value) if (g.mode === 'int') out.push({ kind: 'int', group: g })
  return out
})
const firstTechIndex = computed(() => panelGroups.value.findIndex((g) => g.kind === 'tech'))

// 抽屉组手风琴：桌面多组并存；移动单组展开（toggle 时收掉其他组）
const panelOpen = ref<Record<string, boolean>>({})
function panelDefaultOpen(key: string) {
  return key === 'model' || LABEL_KEYS.includes(key)
}
function isPanelOpen(entry: PanelEntry) {
  // 技术键搜索中：有命中的组自动展开（否则搜到也看不见）
  if (entry.kind === 'tech' && techSearching.value) return techHasHit(entry.group)
  return panelOpen.value[entry.group.key] ?? panelDefaultOpen(entry.group.key)
}
function togglePanelGroup(entry: PanelEntry) {
  const key = entry.group.key
  const cur = panelOpen.value[key] ?? panelDefaultOpen(key)
  if (!cur && isMobile.value) {
    // 单组展开：其余组显式关掉（缺席键回落默认开，不能靠「只写一个 true」）
    const next: Record<string, boolean> = {}
    for (const g of panelGroups.value) next[g.group.key] = g.group.key === key
    panelOpen.value = next
    return
  }
  panelOpen.value = { ...panelOpen.value, [key]: !cur }
}
// 搜索中的技术键组头退化为静态（开合被搜索接管，按钮就是撒谎）
function panelHeadTag(entry: PanelEntry): 'button' | 'span' {
  return entry.kind === 'tech' && techSearching.value ? 'span' : 'button'
}

// 模型组：厂商分组折叠 + Top 值 + 搜索框（03 §4.2 抽屉首行）
const modelGroup = computed(() => filterGroups.value.find((g) => g.key === 'model') ?? null)
const modelSearch = ref('')
const modelSearching = computed(() => modelSearch.value.trim().length > 0)
const modelExpanded = computed(() => !!modelGroup.value && (isExpanded(modelGroup.value) || modelSearching.value))
const modelVendors = computed(() => {
  if (!modelGroup.value) return []
  const qs = modelSearch.value.trim().toLowerCase()
  const groups = vendorGroupsOf(modelGroup.value)
  if (!qs) return groups
  return groups
    .map((g) => ({ group: g.group, values: g.values.filter((v) => v.value.toLowerCase().includes(qs)) }))
    .filter((g) => g.values.length)
})
function vendorOpen(group: string) {
  return modelSearching.value || !isVendorCollapsed(group)
}

// 技术键：可搜索（值/键名/键标签子串命中）；命中组自动展开，无命中的组隐藏
const techSearch = ref('')
const techSearching = computed(() => techSearch.value.trim().length > 0)
function techHasHit(g: FilterGroup) {
  const qs = techSearch.value.trim().toLowerCase()
  if (!qs) return true
  return (
    g.values.some((v) => v.value.toLowerCase().includes(qs)) ||
    g.key.toLowerCase().includes(qs) ||
    g.label.toLowerCase().includes(qs)
  )
}
function techValues(g: FilterGroup) {
  const qs = techSearch.value.trim().toLowerCase()
  if (!qs) return visibleValues(g)
  return g.values.filter((v) => v.value.toLowerCase().includes(qs))
}

// 数值键：快捷档与范围计算已下沉到 utils/demoFacets（可单测）

function activeRangeOf(k: FilterGroup) {
  return selectedTags.value.find((t) => t.startsWith(k.key + ':')) || ''
}
function presetActive(k: FilterGroup, p: QuickPreset) {
  return activeRangeOf(k) === `${k.key}:${p.lo}-${p.hi}`
}
function applyIntRange(k: FilterGroup) {
  const r = intRange.value[k.key] || intBounds(k)
  const keyPrefix = k.key + ':'
  selectedTags.value = selectedTags.value.filter((t) => !t.startsWith(keyPrefix))
  if (r.lo <= r.hi) {
    selectedTags.value.push(`${k.key}:${r.lo}-${r.hi}`)
  }
  applyFilters()
}
function clearIntRange(k: FilterGroup) {
  intRange.value = { ...intRange.value, [k.key]: intBounds(k) }
  selectedTags.value = selectedTags.value.filter((t) => !t.startsWith(k.key + ':'))
  applyFilters()
}
function applyPreset(k: FilterGroup, p: QuickPreset) {
  intRange.value = { ...intRange.value, [k.key]: { lo: p.lo, hi: p.hi } }
  applyIntRange(k)
  // 应用即收（移动端）：档位打上就回列表看结果；再调再开，状态在 URL 里不丢
  if (isMobile.value) closeFacet()
}

function clearTags() {
  selectedTags.value = []
  modelFilter.value = ''
  applyFilters()
}

// 已选 chips 摘要（03 §4.2-1）已下沉到 utils/demoFacets.chipLabel
function clearModelFilter() {
  modelFilter.value = ''
  applyFilters()
}

const sentinel = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null

/**
 * 世代号：加载期间换筛选必须能重查，而在途的旧响应绝不能污染新列表。
 *
 * 旧实现把 `loading` 同时当「UI 态」和「互斥锁」用（`if (loading.value) return`），
 * 于是出现真实可复现的 bug：首屏 `onMounted` 正在 `load(true)` 时点任一标签芯片 →
 * `reset()` 直接 return（不清列表也不重查）→ 紧接着 `syncQuery()` 已把 tag 写进 URL →
 * 路由 watch 触发 `applyRouteQuery()`，而它比较的是**已经改过的 ref** → 判定 changed=false
 * → 不重查。结果：芯片高亮、URL 是 ?tag=x、列表却是未筛选的旧数据，且不会自行恢复。
 * 搜索/排序/区间/清空全走同一条路径。
 *
 * 正解是世代号（不是简单删掉早退 —— 那样在途响应会把旧页 append 进新列表）。
 */
const gen = useLoadGeneration()

async function load(reset = false) {
  const my = gen.next()
  const p = reset ? 1 : page.value
  loading.value = true
  error.value = ''
  try {
    const res = await api.listDemos({
      status: 'approved',
      tags: selectedTags.value,
      q: submittedQ.value || undefined,
      model: modelFilter.value || undefined,
      task: preferTaskSlug.value || undefined,
      sort: cardMode.value === 'prompt' ? 'prompt' : sort.value,
      // random 的会话固定种子：首响拿到 random_seed，后续页回传 —— 整段翻页建立在同一次
      // 洗牌上（后端根修跨时间桶不重复不漏件）；换筛选（reset）清空重新领种子。
      rs: sort.value === 'random' && randomSeed.value ? randomSeed.value : undefined,
      page: p,
      page_size: pageSize,
    })
    if (!gen.isCurrent(my)) return // 作废：已有更新的请求发出/返回，旧结果不许写
    if (reset) {
      demos.value = res.items
      tgOpen.value = {} // 新数据集，旧展开态没有意义
      // 组内全量缓存也属于旧数据集：作废在途补全并清空（否则换筛选后还挂着上一批的组成员）
      groupEpoch++
      groupMembers.value = new Map()
      groupFetched.clear()
    } else demos.value = dedupeBySlug(demos.value, res.items).items // 兜底层：顺序稳定根修在 rs
    if (res.random_seed) randomSeed.value = res.random_seed
    total.value = res.total
    page.value = p + 1
    // 终止条件不能只看「去重后长度 < total」：dedupeBySlug 丢掉的重复件不会再被取回
    // （页码只前进），length 永远追不上 total → hasMore 卡死为 true，「已加载全部 N 个」
    // 永不出现、滚到底后反复发空页请求。空页是服务端分页的权威到底信号。
    hasMore.value = res.items.length > 0 && demos.value.length < res.total
    // 「组一出现就整组可见」：把本页出现的题目补全（不 await，不阻塞列表渲染）
    if (taskGroupOn.value) void ensureGroupMembers(res.items)
  } catch (e) {
    if (!gen.isCurrent(my)) return
    error.value = (e as Error).message
    // 换筛选失败时屏上还是上一组条件的旧结果：清掉，走空列表的 EmptyBox(error) + 重试
    if (reset) demos.value = []
  } finally {
    if (gen.isCurrent(my)) {
      loading.value = false
      refreshing.value = false
    }
  }
}

function reset() {
  gen.invalidate() // 作废在途请求（含「加载更多」——否则它的响应会 append 到新筛选的列表上）
  refreshing.value = true
  // 旧结果留在屏上（压暗 + aria-busy + 状态条）直到新结果到达：清空会让网格塌成一行转圈再长回来，
  // 每点一个筛选页面高度跳两次。不回顶。
  error.value = ''
  page.value = 1
  hasMore.value = true
  randomSeed.value = '' // 新的随机浏览段：重新领种子
  void load(true)
}

function toggleTag(tg: string) {
  const i = selectedTags.value.indexOf(tg)
  if (i >= 0) selectedTags.value.splice(i, 1)
  else selectedTags.value.push(tg)
  applyFilters()
}
// 抽屉内点值 = 应用即收（移动端）：打上一个条件就回列表看结果（03 §4.2-6）。
// 只在「新增」时收——取消勾选是整理动作，留在抽屉里继续调更顺
function pickTag(tg: string) {
  const adding = !selectedTags.value.includes(tg)
  toggleTag(tg)
  if (adding && isMobile.value) closeFacet()
}

function applySort() {
  applyFilters()
}

// 显式提交搜索：只有回车 / 点「搜索」才触发请求
function submitSearch() {
  const next = q.value.trim()
  if (next === submittedQ.value) {
    // 没有新词：空提交等同清除搜索；否则什么都不做
    if (!next && submittedQ.value) {
      submittedQ.value = ''
      reset()
    }
    return
  }
  submittedQ.value = next
  applyFilters()
}

function clearSearch() {
  q.value = ''
  if (submittedQ.value) {
    submittedQ.value = ''
    reset()
    syncQuery()
  }
}

// ---------- 空态三出口（03 §4.5；第 4 口「出一题」= M3 出题候选，留位不实装） ----------
const hasFilters = computed(() => selectedTags.value.length > 0 || !!modelFilter.value || !!submittedQ.value)
const emptyCondN = computed(() => facetCount.value + (submittedQ.value ? 1 : 0))
function relaxFilters() {
  // 放宽 = 去掉最后一个筛选重查（最后添加的最可能是压死结果的那根稻草）
  if (selectedTags.value.length) {
    selectedTags.value = selectedTags.value.slice(0, -1)
    reset()
    syncQuery()
    return
  }
  if (modelFilter.value) {
    clearModelFilter()
    return
  }
  if (submittedQ.value) clearSearch()
}
function switchToPrompt() {
  setCardMode('prompt')
}
// 论坛求助预填：携带当前筛选词进 /forum/new（ForumNewView 支持 ?title= 预填标题）
const askForumTo = computed(() => {
  const parts: string[] = []
  if (submittedQ.value) parts.push(`“${submittedQ.value}”`)
  for (const tg of selectedTags.value) parts.push(chipLabel(tg))
  if (modelFilter.value) parts.push('model:' + modelFilter.value)
  const title = t('demos.askTitle', '求助：找不到满足 {filters} 的作品', { filters: parts.join(' + ') || '…' })
  return { path: '/forum/new', query: { title } }
})


/** 分面（tagKeys）加载失败标记：原先 catch 静默清 []，使得「分面请求挂了」与「真的没有分面」
 *  渲染成同一个「暂无可用分面」。与主列表分开（主列表失败走上面 error 分支），且可独立重试。 */
const facetLoadError = ref(false)

async function loadFacetKeys() {
  facetLoadError.value = false
  try {
    tagKeys.value = await api.listTagKeys()
    initIntRanges(tagKeys.value, intBoundsOf)
  } catch {
    tagKeys.value = []
    facetLoadError.value = true
  }
}

onMounted(async () => {
  // 从 URL query 还原状态
  applyRouteQuery()
  // 分面与列表互不依赖：并行发，别让首屏卡片多等一个往返
  void loadFacetKeys()
  // 返回恢复：**先**读快照并把随机种子装回去，再发第 1 页请求。
  // 顺序是正确性的一部分（2026-10-16 实测）：若先 load(true) 再 pin 种子，第 1 页会用服务端
  // 新发的种子 S2、第 2..N 页才用离开时的 S1 —— 两套置换混排，重复件被 dedupeBySlug 吞掉，
  // 而「只在 S1 第 1 页、又不在 S2 第 1 页也不在 S1 第 2..N 页」的件永久丢失（漏件无兜底）。
  const snap = readDepthSnapshot()
  const restore = snap && snap.sig === depthSig() ? snap : null
  if (restore?.rs) randomSeed.value = restore.rs
  await load(true)
  if (restore) {
    // 把离开时已加载的页依次补齐（load 内部有世代号守卫，这里顺序 await 无并发），
    // 再把滚动落回离开时的位置 —— savedPosition 在第 1 页高度内会被钳底，这里显式校正。
    // 分组展开态一并还原：组开合保持离开时的样子。
    if (restore.tg) tgOpen.value = restore.tg
    const want = Math.min(restore.pages, DEPTH_MAX_PAGES)
    for (let i = 1; i < want && hasMore.value && !error.value; i++) await load(false)
    if (demos.value.length) {
      await nextTick()
      window.scrollTo(0, restore.y)
    }
  }
  observer = new IntersectionObserver(
    (entries) => {
      // reset/首载进行中、或没有更多时，不触发翻页（避免列表塌陷后 sentinel 进视口误翻页）
      if (!entries[0].isIntersecting) return
      if (loading.value || loadingMore.value || refreshing.value || !hasMore.value) return
      loadingMore.value = true
      void load().finally(() => (loadingMore.value = false))
    },
    { rootMargin: '300px' },
  )
  if (sentinel.value) observer.observe(sentinel.value)
})


onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div class="route-page">  <PageHero>
    <span class="eyebrow">{{ t('demos.eyebrow', 'AI 网页 Demo') }}</span>
    <h1 class="page-title">{{ t('app.nav.demos', '作品库') }}</h1>
    <p class="sub">{{ t('demos.sub', '搜索、筛选、浏览全部 AI 网页 Demo —— 支持按标签与热度检索。') }}</p>
    <span class="mini-stat"><b>{{ total }}</b> {{ t('demos.works', '件作品') }}</span>
  </PageHero>

  <section class="section" style="padding-top: var(--sp-8)">
    <!-- 视图栏：模式轨道 + 排序，独立一行，不与搜索/标签混排 -->
    <div class="view-bar">
      <div class="mode-tool">
        <span class="mode-rail-stamp">{{ t('demos.mode', '模式') }}</span>
        <div class="mode-rail" :class="{ prompt: cardMode === 'prompt' }" role="group" aria-label="卡片模式">
          <button class="mode-rail-item" type="button" :aria-pressed="cardMode === 'normal'" @click="setCardMode('normal')">{{ t('demos.normal', '常规') }}</button>
          <button class="mode-rail-item" type="button" :aria-pressed="cardMode === 'prompt'" @click="setCardMode('prompt')">{{ t('demos.prompt', '提示词') }}</button>
          <span class="mode-rail-knob" :class="{ prompt: cardMode === 'prompt' }">
            {{ cardMode === 'prompt' ? t('demos.prompt', '提示词') : t('demos.normal', '常规') }}
          </span>
        </div>
        <span v-if="cardMode === 'prompt'" class="mode-rail-badge">PROMPT</span>
      </div>

      <div v-if="cardMode === 'normal'" class="tabs" style="margin: 0">
        <button class="tab" :class="{ active: sort === 'newest' }" type="button" :aria-pressed="sort === 'newest'" @click="sort = 'newest'; applySort()">{{ t('demos.newest', '最新') }}</button>
        <button class="tab" :class="{ active: sort === 'popular' }" type="button" :aria-pressed="sort === 'popular'" @click="sort = 'popular'; applySort()">{{ t('demos.hot', '最热') }}</button>
        <!-- 03 §4.3：「随机」在数据产品语境里像统计功能，「随便看看」表达消遣心智；移末位 -->
        <button class="tab" :class="{ active: sort === 'random' }" type="button" :aria-pressed="sort === 'random'" @click="sort = 'random'; applySort()">{{ t('demos.casual', '随便看看') }}</button>
      </div>
      <!-- 同题折叠（默认开，记忆）：分组只是呈现层，排序/筛选/分页语义不变。
           做成开关而不是 .tab：黑底 .tab.active 与排序组同形，会被读成"第四种排序" -->
      <button
        class="tg-switch"
        type="button"
        role="switch"
        :aria-checked="taskGroupOn"
        @click="setTaskGroup(!taskGroupOn)"
      >
        <span class="tg-switch-track" aria-hidden="true"><span class="tg-switch-knob"></span></span>
        {{ t('demos.taskGroup', '按题折叠') }}
      </button>
    </div>

    <div class="toolbar demos-toolbar">
      <div class="search-box search-box--grow">
        <input
          v-model="q"
          class="input"
          type="search"
          enterkeyhint="search"
          :placeholder="t('demos.searchPlaceholder', '搜索标题 / 描述 / 标签…（回车提交）')"
          @keydown.enter="!isImeComposing($event) && submitSearch()"
          @search="!q && clearSearch()"
        />
        <button class="btn btn-secondary search-submit" type="button" @click="submitSearch">{{ t('demos.search', '搜索') }}</button>
      </div>
      <!-- 筛选收起为按钮（03 §4.2-1：筛选是间歇动作，浏览是持续状态）；钉住态侧栏常驻，按钮隐 -->
      <button
        v-if="panelMode !== 'pinned'"
        class="btn btn-secondary facet-btn"
        type="button"
        :aria-expanded="showPanel"
        aria-controls="facet-panel"
        @click="toggleFacet"
      >
        {{ t('demos.facet', '筛选') }} ({{ facetCount }})
      </button>
    </div>

    <!-- 已应用搜索词 -->
    <div v-if="submittedQ" class="filter-row tag-selected-row">
      <span class="filter-label">{{ t('demos.search', '搜索') }}</span>
      <button class="tag-chip active" type="button" title="点击移除搜索" @click="clearSearch">
        {{ submittedQ }}<span class="chip-x">X</span>
      </button>
    </div>

    <!-- 已选 chips 摘要条（置顶、可单独/一键移除；含模型实体筛选，不再是无形条件） -->
    <div v-if="selectedTags.length || modelFilter" class="filter-row tag-selected-row">
      <span class="filter-label">{{ t('demos.selected', '已选') }}</span>
      <button
        v-if="modelFilter"
        class="tag-chip teal active"
        type="button"
        :title="t('demos.modelChipTip', '来自模型页的模型实体筛选')"
        @click="clearModelFilter"
      >
        model:{{ modelFilter }}<span class="chip-x">X</span>
      </button>
      <button
        v-for="tg in selectedTags"
        :key="tg"
        class="tag-chip active"
        type="button"
        @click="toggleTag(tg)"
      >
        {{ chipLabel(tg) }}<span class="chip-x">X</span>
      </button>
      <button class="btn btn-sm btn-dark" type="button" @click="clearTags">{{ t('demos.clearTags', '清除全部') }}</button>
    </div>

    <!-- 热门快捷（保留在搜索行下，高频条件前置 03 §4.2-5） -->
    <div v-if="hotChips.length" class="filter-row hot-row">
      <span class="filter-label">{{ t('demos.hotChips', '热门') }}</span>
      <button
        v-for="g in hotChips"
        :key="g.key + ':' + g.value"
        class="tag-chip"
        :class="['mode-' + g.mode, { active: selectedTags.includes(g.key + ':' + g.value) }]"
        type="button"
        @click="toggleTag(g.key + ':' + g.value)"
      >
        {{ keyLabel(g.key) }}:{{ tagLabel(g.value) }}
        <span class="count">{{ g.count }}</span>
      </button>
    </div>

    <div class="facet-body" :class="{ 'facet-body--pinned': panelMode === 'pinned' }">
      <div class="facet-main" :class="{ 'is-refreshing': refreshing && demos.length > 0 }" :aria-busy="loading">
        <div v-if="refreshing && demos.length" class="refresh-flag">
          <span class="refresh-pill" role="status"><span class="spinner"></span>{{ t('demos.refreshing', '正在刷新…') }}</span>
        </div>
        <!-- 错误与空态分离（修复：原先 error 独立渲染，加载失败且列表为空时会同时显示错误横幅
             与「没有匹配的作品」+ 三个筛选出口，误导用户去放宽条件而非重试）。列表非空时
             （加载更多失败）保留顶部提示并给重试；列表为空且失败走上面的 EmptyBox(error)。 -->
        <div v-if="error && demos.length" class="notice notice-error">
          {{ error }}
          <button class="btn btn-sm btn-outline" type="button" @click="load()">{{ t('common.retry', '重试') }}</button>
        </div>

        <div v-if="loading && !demos.length" class="loading-row">
          <span class="spinner"></span> {{ refreshing ? t('demos.refreshing', '正在刷新…') : t('demos.loading', '加载 Demo 中…') }}
        </div>

        <EmptyBox v-else-if="error" kind="error" :text="error" :retry-text="t('common.retry', '重试')" @retry="reset" />

        <div v-else-if="!demos.length" class="empty-box dv-empty">
          <p class="dv-empty-what">{{ t('demos.emptyWhat', '没有匹配的作品') }}</p>
          <p v-if="emptyCondN" class="muted dv-empty-why">
            {{ t('demos.emptyWhy', '当前 {n} 个条件交集为空 —— LIKE 搜索无相关性权重，长尾组合容易空手。', { n: emptyCondN }) }}
          </p>
          <!-- 空态三出口（03 §4.5）；第 4 口「这道题还没有？出一题」= M3 出题候选，留位待出题引擎 -->
          <div v-if="hasFilters" class="filter-row dv-empty-exits">
            <button class="btn btn-sm" type="button" @click="relaxFilters">{{ t('demos.relax', '放宽条件') }}</button>
            <button v-if="cardMode === 'normal'" class="btn btn-sm" type="button" @click="switchToPrompt">{{ t('demos.retryPrompt', '按提示词模式再看一次') }}</button>
            <RouterLink class="btn btn-sm btn-outline" :to="askForumTo">{{ t('demos.askForum', '去论坛求助') }}</RouterLink>
          </div>
        </div>

        <!-- 同题 demo 组：收起态 = 堆叠卡（占瀑布流一个格子）；展开时**跨满整行**，
             组内自己排多列（内部网格在 DemoGroupStack 里），不再把一列拉长 -->
        <template v-if="taskGroupOn">
          <!-- 块之间要留和瀑布流一致的垂直间隙：MasonryGrid 只有列内 gap，块与块默认是贴着的 -->
          <div class="dv-blocks">
            <template v-for="b in blocks" :key="b.key">
              <MasonryGrid
                v-if="b.kind === 'grid'"
                :items="b.units"
                :item-key="(u: unknown) => (u as ListUnit<DemoSummary>).key"
              >
                <template #default="{ item }">
                  <DemoGroupStack
                    v-if="isGroupUnit(item)"
                    :unit-key="groupOf(item).key"
                    :group="groupOf(item).group"
                    :rep="groupOf(item).rep"
                    :open="false"
                    :complete="isGroupComplete(groupOf(item).group.key)"
                    :prompt-mode="cardMode === 'prompt'"
                    @toggle="toggleUnit(groupOf(item))"
                  />
                  <PromptDemoCard v-else-if="cardMode === 'prompt'" :demo="demoOf(item)" />
                  <DemoCard v-else :demo="demoOf(item)" />
                </template>
              </MasonryGrid>
              <DemoGroupStack
                v-else
                :unit-key="b.unit.key"
                :group="b.unit.group"
                :rep="b.unit.rep"
                :open="true"
                :complete="isGroupComplete(b.unit.group.key)"
                :prompt-mode="cardMode === 'prompt'"
                @toggle="toggleUnit(b.unit)"
              />
            </template>
          </div>
        </template>
        <MasonryGrid v-else :items="demos" :item-key="(d: unknown) => (d as DemoSummary).slug">
          <template #default="{ item }">
            <PromptDemoCard v-if="cardMode === 'prompt'" :demo="item as DemoSummary" />
            <DemoCard v-else :demo="item as DemoSummary" />
          </template>
        </MasonryGrid>

        <div ref="sentinel" class="loading-row">
          <template v-if="loadingMore"><span class="spinner"></span> {{ t('demos.loadMore', '加载更多…') }}</template>
          <template v-else-if="!hasMore">{{ t('demos.allLoaded', '已加载全部 {n} 个 Demo', { n: total }) }}</template>
        </div>
      </div>

      <!-- 遮罩：overlay / bottom-sheet 共用（钉住态无遮罩） -->
      <div v-if="backdropActive" class="facet-backdrop" aria-hidden="true" @click="closeFacet"></div>

      <!-- 分面抽屉：桌面 overlay（可钉住） / 钉住=常驻侧栏 / 移动 bottom-sheet -->
      <aside
        v-if="showPanel"
        id="facet-panel"
        ref="panelEl"
        class="facet-panel"
        :class="'facet-panel--' + panelMode"
        role="dialog"
        :aria-label="t('demos.facetTitle', '分面筛选')"
        tabindex="-1"
      >
        <header class="fp-head">
          <b class="fp-title">{{ t('demos.facetTitle', '分面筛选') }}</b>
          <span class="fp-count">{{ t('demos.selectedN', '已选 {n}', { n: facetCount }) }}</span>
          <span class="fp-flex"></span>
          <button
            v-if="panelMode === 'overlay'"
            class="fp-pin"
            type="button"
            :title="t('demos.pinTip', '钉住为常驻侧栏（记忆）')"
            @click="pinFacet"
          >{{ t('demos.pin', '钉住') }}</button>
          <button
            v-else-if="panelMode === 'pinned'"
            class="fp-pin fp-pin--on"
            type="button"
            :title="t('demos.unpinTip', '取消钉住，回到浮层')"
            @click="unpinFacet"
          >{{ t('demos.unpin', '已钉住') }}</button>
          <button
            v-if="panelMode !== 'pinned'"
            class="fp-close"
            type="button"
            :aria-label="t('demos.close', '关闭')"
            @click="closeFacet"
          >X</button>
        </header>
        <!-- OR/AND 语义显性化（03 §4.2-3）：组间注一条（跨组叠加=且），组头注一条（同组任选=或）；
             移动端组头注被空间挤掉，OR 注并进这行（双语微文案在 ≤720 不失踪） -->
        <p class="fp-grammar">
          {{ t('demos.grammarAnd', '跨组叠加 = 且') }}
          <span class="fp-grammar-or-line"> · {{ t('demos.grammarOr', '同组任选 = 或') }}</span>
        </p>

        <div v-if="!panelGroups.length" class="fp-empty muted">
          <template v-if="facetLoadError">
            {{ t('demos.facetLoadFailed', '分面加载失败') }}
            <button class="btn btn-sm btn-outline" type="button" @click="loadFacetKeys">{{ t('common.retry', '重试') }}</button>
          </template>
          <template v-else>{{ t('demos.noFacets', '暂无可用分面') }}</template>
        </div>
        <template v-else>
          <template v-for="(g, gi) in panelGroups" :key="g.group.key">
            <!-- 技术键搜索框：悬在技术键段之前（该段唯一共享控件） -->
            <input
              v-if="gi === firstTechIndex"
              v-model="techSearch"
              class="input fp-search fp-search--tech"
              type="search"
              :placeholder="t('demos.searchTech', '搜索技术标签值…')"
              :aria-label="t('demos.searchTech', '搜索技术标签值…')"
            />
            <section class="fp-group" :class="'mode-' + g.group.mode">
              <component
                :is="panelHeadTag(g)"
                class="fp-group-head"
                :type="panelHeadTag(g) === 'button' ? 'button' : undefined"
                :aria-expanded="panelHeadTag(g) === 'button' ? isPanelOpen(g) : undefined"
                @click="panelHeadTag(g) === 'button' && togglePanelGroup(g)"
              >
                <span class="fp-caret" :class="{ open: isPanelOpen(g) }" aria-hidden="true">▸</span>
                <span class="fp-group-name">{{ keyLabel(g.group.key, g.group.label) }}</span>
                <code class="fp-group-code">{{ g.group.key }}</code>
                <span class="mode-dot" :class="'mode-dot-' + g.group.mode" aria-hidden="true"></span>
                <!-- int 组每次只允许一段范围（应用即替换），「同组任选」不适用——OR 注只在多选组出现 -->
                <span v-if="g.kind !== 'int'" class="fp-grammar-or">{{ t('demos.grammarOr', '同组任选 = 或') }}</span>
              </component>

              <div v-if="isPanelOpen(g)" class="fp-group-body">
                <!-- ① 模型组：厂商分组折叠保留 + 搜索框（Top 值） -->
                <template v-if="g.kind === 'model'">
                  <input v-model="modelSearch" class="input fp-search" type="search" :placeholder="t('demos.searchModels', '搜索模型…')" :aria-label="t('demos.searchModels', '搜索模型…')" />
                  <button v-if="!modelExpanded" class="tag-chip tag-strip-toggle" type="button" @click="toggleGroup(g.group)">
                    {{ t('demos.modelsExpandN', '模型 · 展开 +{n}', { n: g.group.values.length }) }}
                  </button>
                  <template v-else>
                    <div v-for="vg in modelVendors" :key="vg.group" class="vendor-strip">
                      <button
                        class="vendor-strip-head"
                        type="button"
                        data-reset
                        :aria-expanded="vendorOpen(vg.group)"
                        :aria-label="`${vendorLabel(vg.group)}：${vendorOpen(vg.group) ? t('demos.collapse', '收起') : t('demos.expand', '展开')}`"
                        @click="toggleVendor(vg.group)"
                      >
                        <span class="vendor-dot" :style="{ background: vendorDot(vg.group) }" aria-hidden="true"></span>
                        <span class="vendor-strip-name">{{ vendorLabel(vg.group) }}</span>
                        <span class="vendor-strip-toggle">{{ vendorOpen(vg.group) ? t('demos.collapse', '收起') : t('demos.expand', '展开') }}</span>
                      </button>
                      <div v-if="vendorOpen(vg.group)" class="filter-row" style="margin: 0">
                        <button
                          v-for="v in vg.values"
                          :key="v.value"
                          class="tag-chip mode-fixed"
                          :class="{ active: selectedTags.includes(g.group.key + ':' + v.value) }"
                          type="button"
                          @click="pickTag(g.group.key + ':' + v.value)"
                        >{{ tagLabel(v.value) }}<span class="count">{{ v.count }}</span><TagTip :tag-key="g.group.key" :value="v.value" :description="v.description" /></button>
                      </div>
                    </div>
                    <button v-if="!modelSearching" class="tag-chip tag-strip-toggle" type="button" @click="toggleGroup(g.group)">{{ t('demos.collapse', '收起') }}</button>
                    <span v-if="modelSearching && !modelVendors.length" class="muted fp-nomatch">{{ t('demos.searchNoHit', '无命中') }}</span>
                  </template>
                </template>

                <!-- ② type/category/game 与 ③ 技术键：同一套 chips（TagGroupBox 的厂商猜测分组
                     在抽屉里会渲染成多余的「其他」套盒，且 select 态无 TagTip——按 03 §4.2 线框
                     用 chips 直排；组盒仍服务探索页/面板展示形态） -->
                <template v-else-if="g.kind === 'label' || g.kind === 'tech'">
                  <div class="filter-row" style="margin: 0">
                    <button
                      v-for="v in (g.kind === 'tech' ? techValues(g.group) : visibleValues(g.group))"
                      :key="v.value"
                      class="tag-chip"
                      :class="['mode-' + g.group.mode, { active: selectedTags.includes(g.group.key + ':' + v.value) }]"
                      type="button"
                      @click="pickTag(g.group.key + ':' + v.value)"
                    >
                      {{ tagLabel(v.value) }}
                      <span class="count">{{ v.count }}</span>
                      <TagTip :tag-key="g.group.key" :value="v.value" :description="v.description" />
                    </button>
                    <button
                      v-if="g.kind === 'label' && isCollapsed(g.group) && g.group.values.length > COLLAPSED_SHOW"
                      class="tag-chip tag-strip-toggle"
                      type="button"
                      @click="toggleGroup(g.group)"
                    >
                      {{ t('demos.expandN', '展开 +{n}', { n: hiddenCount(g.group) }) }}
                    </button>
                    <button
                      v-if="g.kind === 'label' && !isCollapsed(g.group)"
                      class="tag-chip tag-strip-toggle"
                      type="button"
                      @click="toggleGroup(g.group)"
                    >
                      {{ t('demos.collapse', '收起') }}
                    </button>
                  </div>
                  <span v-if="g.kind === 'tech' && techSearching && !techHasHit(g.group)" class="muted fp-nomatch">{{ t('demos.searchNoHit', '无命中') }}</span>
                </template>

                <!-- ④ 数值键：快捷档 + 自定义滑条并存 -->
                <template v-else-if="g.kind === 'int'">
                  <div v-if="quickPresets(g.group).length" class="filter-row" style="margin: 0">
                    <button
                      v-for="p in quickPresets(g.group)"
                      :key="p.label"
                      class="tag-chip mode-int"
                      :class="{ active: presetActive(g.group, p) }"
                      type="button"
                      @click="applyPreset(g.group, p)"
                    >{{ p.label }}</button>
                  </div>
                  <div class="filter-row" style="margin: 0">
                    <RangeSlider :min="intBounds(g.group).lo" :max="intBounds(g.group).hi" :label="keyLabel(g.group.key, g.group.label)" v-model="intRange[g.group.key]" />
                    <button class="btn btn-sm btn-secondary" type="button" @click="applyIntRange(g.group); isMobile && closeFacet()">{{ t('demos.apply', '应用') }}</button>
                    <button v-if="activeRangeOf(g.group)" class="btn btn-sm btn-dark" type="button" @click="clearIntRange(g.group)">{{ t('demos.clearRange', '清除') }}</button>
                  </div>
                </template>
              </div>
            </section>
          </template>
        </template>
      </aside>
    </div>
  </section>
  </div>
</template>

<style scoped>
/* ============================================================
   M1-A 分面抽屉（03 §4.2）——styles/ 冻结令：新样式全 scoped，
   令牌经 var() 引用全局既有值并带字面回落（纸白兜底，双主题自动）。
   ============================================================ */
/* 主体栅格：钉住态=主列+340px 常驻侧栏；非钉住=单列。列宽变化 0ms 硬切（t22/t23 口径） */
.facet-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--sp-24);
  align-items: start;
  transition: none;
}
.facet-body--pinned {
  grid-template-columns: minmax(0, 1fr) 340px;
}
.facet-main {
  position: relative;
  min-width: 0;
}

.facet-backdrop {
  position: fixed;
  inset: 0;
  /* P1 底栏契约：遮罩必须压过底栏（900），否则底栏在遮罩"之上"仍亮着，且 sheet 底部被切 58px。
     三者保持相对序：遮罩 < 浮层 < 底部 sheet，统一挂在 --z-sheet 段位上。 */
  z-index: calc(var(--z-sheet) - 2);
  background: rgba(0, 0, 0, 0.32);
}

.facet-panel {
  /* 三律 1 无边框（05 §5.2）：去 4px 边框与 8px 双向影——纯色填充直接着地，
     唯一视觉边界=外部投影一刀（--shadow-black 单源硬影） */
  border: none;
  background: var(--paper, #fff);
  box-shadow: var(--shadow-black, 6px 0 0 var(--ink, #000));
  display: flex;
  flex-direction: column;
  min-height: 0;
}
/* 浮层：顶栏之下、TagTip(--z-dropdown) 之上的 drawer 段位；入场=b-stamp-drop 350ms 落下回弹一次（关闭 0ms 对称） */
.facet-panel--overlay {
  position: fixed;
  top: 78px;
  right: 16px;
  bottom: 16px;
  width: min(360px, calc(100vw - 32px));
  z-index: calc(var(--z-sheet) - 1); /* P1：与 sheet 同段位保持相对序（遮罩 < 浮层 < sheet） */
  overflow-y: auto;
  overscroll-behavior: contain;
  animation: b-stamp-drop var(--b-dur-stage, 350ms) var(--b-ease-stamp, cubic-bezier(0.16, 1, 0.3, 1)) both;
}
/* 移动 bottom-sheet：**压过底栏**（P1 底栏契约），安全区仍由自己垫（它盖住了底栏，成为屏幕最底件）；
   入场=贴边方向镜像落下（从下方 24px 升起同帧谱） */
.facet-panel--sheet {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: var(--z-sheet); /* P1：原 46 低于底栏 900 → 最后 58px 被整条盖住，末项点不到 */
  max-height: 76vh;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-bottom: env(safe-area-inset-bottom, 0px);
  animation: fp-drop-up var(--b-dur-stage, 350ms) var(--b-ease-stamp, cubic-bezier(0.16, 1, 0.3, 1)) both;
}
/* b-stamp-drop 的贴边镜像（bottom-sheet 专用，帧谱同 05 §5.2：升起→overshoot→回弹→落定） */
@keyframes fp-drop-up {
  0% { transform: translateY(24px); opacity: 0; }
  58% { transform: translateY(-3px); opacity: 1; }
  80% { transform: translateY(1px); }
  100% { transform: translateY(0); }
}
/* 钉住=栅格成员常驻侧栏：sticky 跟随，随列内滚动。
   入场保持 0ms 硬切（t22/t23 裁决优先：列宽变化不补间——钉住是栅格成员不是弹层，
   与「三态同 drop」的字面分歧记录给 t34 走查仲裁） */
.facet-panel--pinned {
  position: sticky;
  top: 78px;
  max-height: calc(100vh - 96px);
  overflow-y: auto;
  overscroll-behavior: contain;
  align-self: start;
}
@media (prefers-reduced-motion: reduce) {
  .facet-panel--overlay,
  .facet-panel--sheet {
    animation: none;
  }
}

.fp-head {
  display: flex;
  align-items: center;
  gap: var(--sp-8);
  padding: var(--sp-8) var(--sp-12);
  background: var(--ink, #000);
  color: var(--paper, #fff);
  position: sticky;
  top: 0;
  z-index: var(--z-overlay);
}
.fp-title {
  font-family: var(--font-heading, sans-serif);
  font-weight: 900;
  text-transform: uppercase;
  font-size: var(--fs-13);
  letter-spacing: 0.04em;
}
.fp-count {
  font-family: var(--font-body, monospace);
  font-size: var(--fs-11);
  font-weight: 700;
  background: var(--paper, #fff);
  color: var(--ink, #000);
  padding: 1px 7px;
}
.fp-flex {
  flex: 1;
}
.fp-pin {
  font: inherit;
  font-size: var(--fs-11);
  font-weight: 800;
  letter-spacing: 0.04em;
  background: transparent;
  color: var(--paper, #fff);
  border: 2px solid var(--paper, #fff);
  padding: 3px var(--sp-8);
  cursor: pointer;
}
@media (hover: hover) {
  .fp-pin:hover {
    background: var(--paper, #fff);
    color: var(--ink, #000);
  }
}
.fp-pin:active {
  transform: translate(2px, 2px);
  transition-duration: 0ms;
}
.fp-pin--on {
  background: var(--yellow, #ffd93d);
  color: var(--ink, #000);
  border-color: var(--ink, #000);
}
.fp-close {
  font: inherit;
  font-weight: 900;
  font-size: var(--fs-14);
  background: transparent;
  border: none;
  color: var(--paper, #fff);
  cursor: pointer;
  min-width: 44px; /* 触达底线（sheet 关闭键在移动端） */
  min-height: 44px;
}
.fp-grammar {
  margin: 0;
  padding: var(--sp-8) var(--sp-12) 0;
  font-size: var(--fs-10);
  letter-spacing: 0.05em;
  color: var(--ink-soft, #555);
}
.fp-empty {
  padding: 18px var(--sp-12);
  font-size: var(--fs-13);
}
.fp-search {
  width: 100%;
}
.fp-search--tech {
  margin-bottom: var(--sp-8);
}
.fp-nomatch {
  font-size: var(--fs-12);
}

/* 组（手风琴）：三律 2 实线分割（05 §5.2）——组间 2px 实线 divider，节奏靠线不靠盒；
   头=44px 触达线 + 11px 大写字距小标题；组间注=组头右侧的 OR 微文案 */
.fp-group {
  border-top: 2px solid var(--ink, #000);
}
.fp-group:first-of-type {
  border-top: none;
}
.fp-group-head {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  width: 100%;
  min-height: 44px;
  padding: var(--sp-8) var(--sp-12);
  background: none;
  border: none;
  cursor: pointer;
  font: inherit;
  text-align: left;
  color: var(--ink, #000);
}
span.fp-group-head {
  cursor: default;
}
@media (hover: hover) {
  button.fp-group-head:hover {
    background: var(--paper-deep, #f2eee6);
  }
}
.fp-caret {
  display: inline-block;
  font-weight: 900;
  font-size: var(--fs-11);
  transition: transform var(--b-dur, 150ms) var(--b-ease, cubic-bezier(0, 0, 0.2, 1));
}
.fp-caret.open {
  transform: rotate(90deg);
}
.fp-group-name {
  font-weight: 900;
  font-size: var(--fs-11); /* 三律 2：组头=11px 大写字距小标题（05 §5.2） */
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.fp-group-code {
  font-size: var(--fs-10);
  color: var(--ink-soft, #555);
}
.fp-grammar-or {
  margin-left: auto;
  font-size: var(--fs-10);
  color: var(--ink-soft, #555);
  white-space: nowrap;
}
@media (max-width: 720px) {
  /* 移动：头拥挤，OR 注从组头隐（fp-grammar 行并入了 OR/AND 全语义） */
  .fp-grammar-or {
    display: none;
  }
  .facet-body--pinned {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (min-width: 721px) { /* P0-3 断点收缝：720.02 → 721（与 max-720 互补，不留缝隙） */
  /* 桌面：组头已有 OR 注，行内不重复 */
  .fp-grammar-or-line {
    display: none;
  }
}
.fp-group-body {
  padding: var(--sp-2) var(--sp-12) var(--sp-12);
  display: grid;
  gap: var(--sp-8);
}

/* 空态三出口（03 §4.5） */
.dv-empty {
  padding: 28px var(--sp-16);
}
.dv-empty-what {
  font-family: var(--font-heading, sans-serif);
  font-weight: 900;
  font-size: 17px;
  margin: 0 0 var(--sp-6);
}
.dv-empty-why {
  font-size: var(--fs-12);
  margin: 0 0 var(--sp-14);
  max-width: 52ch;
  margin-left: auto;
  margin-right: auto;
}
.dv-empty-exits {
  justify-content: center;
  margin: 0;
}

@media (prefers-reduced-motion: reduce) {
  .fp-caret {
    transition: none;
  }
}

/* ============================================================
   同题 demo 组的样式已随「整行组头 → 堆叠卡」迁到
   components/DemoGroupStack.vue 的 scoped 块；本文件只留
   下面的 .tg-switch（「按题折叠」开关）。
   ============================================================ */

/* B2 键盘可达：.vendor-strip-head 的结构样式（flex/gap/padding/hover）在 styles/pages/demos.css，
   冻结区不动；UA 默认按钮样式的清零收口在 styles/base/reset.css 的
   `:where(button[data-reset])`（特异性 0，保证不会盖掉冻结区）。
   此处只补冻结区没声明、而 button 默认会带上的两项——**不要**再写 all: unset / display /
   align-items / gap / cursor：scoped 编译后特异性 0-2-1，会抹掉冻结区的
   background(mint) / border-bottom / padding / gap(--sp-8)（2026-10-16 实测）。 */
button[data-reset].vendor-strip-head {
  width: 100%;
  font: inherit;
}
/* 焦点可见性与站点一致：focus 走 hover 的纸深底（与 fp-group-head 的 hover/focus 处理同款） */
@media (hover: hover) {
  button[data-reset].vendor-strip-head:hover,
  button[data-reset].vendor-strip-head:focus-visible {
    background: var(--paper-deep, #f2eee6);
  }
}
button[data-reset].vendor-strip-head:focus-visible {
  background: var(--paper-deep, #f2eee6);
}

/* ---- 同题折叠开关：轨道 + 方块滑钮（颜色 0ms 硬切，只有滑钮位移走 150ms） ---- */
.tg-switch {
  display: inline-flex;
  align-items: center;
  align-self: center;
  gap: var(--sp-8);
  min-height: 44px;
  padding: 0 var(--sp-4);
  background: none;
  border: none;
  font: inherit;
  font-size: var(--fs-13);
  font-weight: 700;
  color: var(--ink, #000);
  cursor: pointer;
  white-space: nowrap;
}
.tg-switch:focus-visible {
  outline: 3px solid var(--ink, #000);
  outline-offset: 2px;
}
.tg-switch-track {
  position: relative;
  flex: none;
  width: 36px;
  height: 20px;
  border: 2px solid var(--ink, #000);
  background: var(--paper, #fff);
}
.tg-switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  background: var(--ink, #000);
  transition: transform var(--b-dur, 150ms) var(--b-ease, cubic-bezier(0, 0, 0.2, 1));
}
.tg-switch[aria-checked='true'] .tg-switch-track {
  background: var(--yellow, #ffd93d);
}
.tg-switch[aria-checked='true'] .tg-switch-knob {
  transform: translateX(16px);
}

/* ---- 分组模式的分块渲染：普通单元段与展开的整行组块之间要留白 ----
   MasonryGrid 只负责列内 gap，块与块在普通流里默认是贴着的。 */
.dv-blocks {
  display: flex;
  flex-direction: column;
  gap: var(--sp-24);
}

/* ---- 换筛选时：旧结果压暗留在原位，状态条吸顶浮在结果上方（零高度，不推挤布局） ---- */
.is-refreshing > .masonry,
.is-refreshing > .dv-blocks {
  opacity: 0.45;
}
.refresh-flag {
  position: sticky;
  top: var(--sp-12);
  z-index: var(--z-local);
  height: 0;
  display: flex;
  justify-content: center;
}
.refresh-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-8);
  height: max-content;
  padding: var(--sp-6) var(--sp-12);
  background: var(--paper, #fff);
  border: 2px solid var(--ink, #000);
  box-shadow: var(--b-shadow);
  font-size: var(--fs-12);
  font-weight: 700;
  text-transform: uppercase;
}

@media (max-width: 720px) {
  /* 搜索与「筛选」同一行：竖排时两条控件 + 视图栏把首屏占满，第一张卡片落在 900px 之外 */
  .demos-toolbar {
    flex-direction: row;
    flex-wrap: nowrap;
    align-items: stretch;
    gap: var(--sp-8);
  }
  .demos-toolbar .search-box {
    flex: 1 1 auto;
    min-width: 0;
  }
  .demos-toolbar .facet-btn {
    flex: none;
  }
  /* 热门芯片单行横滑：换行时 6 个芯片占三行 */
  .hot-row {
    flex-wrap: nowrap;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
    padding-bottom: var(--sp-4);
  }
  .hot-row > * {
    flex: none;
  }
  .tg-switch {
    align-self: flex-start;
  }
}
</style>
