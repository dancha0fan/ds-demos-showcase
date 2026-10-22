import type { DemoSummary, Paginated, PromptListParams, PromptProposalIn, PromptProposalOut, PromptSummary, SuggestionItem } from './types'

type Entry = Pick<PromptSummary, 'id' | 'title' | 'content' | 'category' | 'source_url' | 'created_at'> & { contributed: boolean }
const normalize = (text: string) => text.replace(/\r\n/g, '\n').trim()

/** 离线演示与真实接口共用可见性、固定正文和待审语义。 */
export function createMockPromptStore(deps: {
  demos: () => DemoSummary[]
  userId: () => number | null
  suggestions: SuggestionItem[]
  nextSuggestionId: () => number
}) {
  const entries = new Map<string, Entry>()
  let seq = 0

  function ensure(content: string, title: string, createdAt: string): Entry {
    const key = normalize(content)
    let entry = entries.get(key)
    if (!entry) {
      entry = { id: ++seq, title, content: key, category: null, source_url: null, created_at: createdAt, contributed: false }
      entries.set(key, entry)
    }
    return entry
  }

  function summaries(): PromptSummary[] {
    const visible = deps.demos().filter((d) => d.status === 'approved' && normalize(d.prompt || ''))
    for (const d of [...visible].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
      ensure(d.prompt || '', d.title, d.created_at)
    }
    return [...entries.values()].flatMap((e) => {
      const works = visible.filter((d) => normalize(d.prompt || '') === e.content)
      if (!e.contributed && !works.length) return []
      const models = new Set(works.flatMap((d) => (d.models || []).map((m) => m.id)))
      return [{ id: e.id, title: e.title, content: e.content, category: e.category, source_url: e.source_url,
        created_at: e.created_at, source: e.contributed ? 'contributed' as const : 'demo' as const,
        demos_total: works.length, models_total: models.size }]
    })
  }

  function paginate<T>(items: T[], page = 1, pageSize = 12): Paginated<T> {
    const p = Math.max(1, page)
    const size = Math.max(1, Math.min(100, pageSize))
    return { items: items.slice((p - 1) * size, p * size), total: items.length, page: p, page_size: size }
  }

  function list(params: PromptListParams = {}): Paginated<PromptSummary> {
    const q = (params.q || '').trim().toLowerCase()
    const items = summaries().filter((p) => (!q || `${p.title}\n${p.content}`.toLowerCase().includes(q))
      && (!params.category || p.category === params.category)
      && (params.has_results === undefined || (p.demos_total > 0) === params.has_results))
    items.sort((a, b) => (params.sort === 'most_tested' ? b.demos_total - a.demos_total : 0)
      || b.created_at.localeCompare(a.created_at) || b.id - a.id)
    return paginate(items, params.page, params.page_size)
  }

  function get(id: number): PromptSummary {
    const entry = summaries().find((e) => e.id === id)
    if (!entry) throw new Error('提示词不存在或未公开')
    return entry
  }

  function demos(id: number, params: { page?: number; page_size?: number } = {}): Paginated<DemoSummary> {
    const entry = get(id)
    const works = deps.demos().filter((d) => d.status === 'approved' && normalize(d.prompt || '') === entry.content)
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.slug.localeCompare(b.slug))
    return paginate(works, params.page, params.page_size)
  }

  function validate(input: PromptProposalIn): PromptProposalIn {
    const title = input.title.trim()
    const content = normalize(input.content)
    const category = input.category?.trim() || null
    const source = input.source_url?.trim() || null
    if (!title || title.length > 200 || !content || content.length > 20000 || (category?.length || 0) > 64) {
      throw new Error('请检查标题、正文和分类长度')
    }
    if (source) {
      let url: URL
      try { url = new URL(source) } catch { throw new Error('来源需为完整的 HTTP(S) 链接') }
      const authority = source.match(/^https?:\/\/([^/?#]*)/i)?.[1]
      if (!authority || authority.includes('@') || !['http:', 'https:'].includes(url.protocol) || source.length > 2048 || url.username || url.password
        || Array.from(source).some((char) => /\s/u.test(char) || char.charCodeAt(0) < 32 || char === '\u0085')) throw new Error('来源需为完整的 HTTP(S) 链接')
    }
    return { title, content, category, source_url: source }
  }

  function propose(input: PromptProposalIn): PromptProposalOut {
    const userId = deps.userId()
    if (userId === null) throw new Error('请先登录')
    const body = validate(input)
    const existing = summaries().find((p) => p.content === body.content)
    if (existing) return { status: 'existing', prompt_id: existing.id }
    const pending = deps.suggestions.find((s) => s.kind === 'new_prompt' && s.status === 'pending'
      && s.payload.created_by === userId && s.payload.content === body.content)
    if (pending) return { status: 'pending', suggestion_id: pending.id }
    const id = deps.nextSuggestionId()
    deps.suggestions.push({ id, kind: 'new_prompt', source: 'user', status: 'pending', confidence: 0.98,
      payload: { ...body, created_by: userId, scope: 'deep' }, created_at: new Date().toISOString() })
    return { status: 'pending', suggestion_id: id }
  }

  function approve(s: SuggestionItem): number {
    const body = validate({ title: String(s.payload.title || ''), content: String(s.payload.content || ''),
      category: s.payload.category ? String(s.payload.category) : null, source_url: s.payload.source_url ? String(s.payload.source_url) : null })
    summaries()
    const entry = ensure(body.content, body.title, new Date().toISOString())
    if (!entry.contributed) {
      entry.title = body.title
      entry.category = body.category || null
      entry.source_url = body.source_url || null
      entry.contributed = true
    }
    s.payload.prompt_id = entry.id
    s.result = `/prompts/${entry.id}`
    return entry.id
  }

  return { list, get, demos, propose, approve }
}
