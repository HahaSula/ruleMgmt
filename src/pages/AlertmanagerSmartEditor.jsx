import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import VersionModal from '../components/VersionModal'
import { listTemplates, getTemplate, saveTemplate, deleteTemplate, pruneRoutesAPI } from '../utils/api'
import { latestVersion, bumpPatch } from '../utils/templateUtils'

const MATCHER_OPS = ['=', '!=', '=~', '!~']
const TYPE = 'amconfig'

// ── Label extraction ──────────────────────────────────────────────────────────

function collectLabels(suiteData, out) {
  if (!suiteData) return
  out.add('alertname')
  out.add('severity')
  for (const key of Object.keys(suiteData.groupLabels || {})) {
    if (key.trim()) out.add(key)
  }
  for (const rule of suiteData.rules || []) {
    // labels/vars saved as plain objects by buildPayload in AlertSuiteEditor
    for (const key of Object.keys(rule.labels || {})) {
      if (key.trim()) out.add(key)
    }
    const expr = rule.expr || rule.vars?.expr || ''
    for (const match of [...expr.matchAll(/\bby\s*\(([^)]+)\)/gi)]) {
      for (const lbl of match[1].split(',').map(s => s.trim()).filter(Boolean)) {
        out.add(lbl)
      }
    }
  }
}

// ── Route pruning ─────────────────────────────────────────────────────────────

function matcherKey(m) { return `${m.key}\x00${m.op}\x00${m.value}` }

function pruneRoutes(rules, topMatchers = []) {
  const topKeys = new Set(topMatchers.filter(m => m.key.trim()).map(matcherKey))
  const active = rules.filter(r => r.receiver && r.matchers.some(m => m.key.trim()))
    .map(r => ({
      ...r,
      matchers: r.matchers.filter(m => m.key.trim() && !topKeys.has(matcherKey(m))),
    }))
    .filter(r => r.matchers.length > 0 || r.receiver)

  function isSubset(small, large) {
    const largeKeys = new Set(large.map(matcherKey))
    return small.every(m => largeKeys.has(matcherKey(m)))
  }

  const isChild = new Set()
  const parentOf = new Map()
  for (let i = 0; i < active.length; i++) {
    for (let j = 0; j < active.length; j++) {
      if (i === j || parentOf.has(j)) continue
      const mi = active[i].matchers, mj = active[j].matchers
      if (mi.length < mj.length && isSubset(mi, mj)) {
        isChild.add(j)
        parentOf.set(j, i)
      }
    }
  }

  const result = []
  for (let i = 0; i < active.length; i++) {
    if (isChild.has(i)) continue
    const parentMs = active[i].matchers
    const parentMsKeys = new Set(parentMs.map(matcherKey))
    const children = [...parentOf.entries()]
      .filter(([, pi]) => pi === i)
      .map(([ci]) => ({
        receiver: active[ci].receiver,
        matchers: active[ci].matchers.filter(m => !parentMsKeys.has(matcherKey(m))),
      }))
    const route = { receiver: active[i].receiver, matchers: parentMs }
    if (children.length) route.routes = children
    result.push(route)
  }
  return result
}

function renderRouteBlock(routes, pad) {
  let s = ''
  for (const r of routes) {
    s += `${pad}- receiver: ${JSON.stringify(r.receiver)}\n`
    if (r.matchers?.length) {
      s += `${pad}  matchers:\n`
      for (const m of r.matchers)
        s += `${pad}    - name: ${m.key}\n${pad}      matchType: "${m.op || '='}"\n${pad}      value: ${JSON.stringify(m.value)}\n`
    }
    if (r.routes?.length) {
      s += `${pad}  routes:\n`
      s += renderRouteBlock(r.routes, pad + '    ')
    }
  }
  return s
}

// ── YAML builder ──────────────────────────────────────────────────────────────

function renderReceiverConfig(rx) {
  let s = `    - name: ${JSON.stringify(rx.name)}\n`
  if (rx.webhook_configs?.length) {
    s += `      webhookConfigs:\n`
    for (const wh of rx.webhook_configs)
      s += `        - url: ${JSON.stringify(wh.url || '')}\n          sendResolved: ${wh.send_resolved ?? true}\n`
  }
  if (rx.slack_configs?.length) {
    s += `      slackConfigs:\n`
    for (const sl of rx.slack_configs)
      s += `        - apiURL: ${JSON.stringify(sl.api_url || '')}\n          channel: ${JSON.stringify(sl.channel || '')}\n          sendResolved: ${sl.send_resolved ?? true}\n`
  }
  if (rx.pagerduty_configs?.length) {
    s += `      pagerdutyConfigs:\n`
    for (const pd of rx.pagerduty_configs)
      s += `        - routingKey: ${JSON.stringify(pd.routing_key || '')}\n          sendResolved: ${pd.send_resolved ?? true}\n`
  }
  if (rx.email_configs?.length) {
    s += `      emailConfigs:\n`
    for (const em of rx.email_configs)
      s += `        - to: ${JSON.stringify(em.to || '')}\n          from: ${JSON.stringify(em.from || '')}\n          smarthost: ${JSON.stringify(em.smarthost || '')}\n`
  }
  return s
}

function buildYAML(configName, defaultRecv, routeMatchers, routeRules, embeddedReceivers, inhibitRules, routeMode, product, precomputedRoutes = null) {
  const pfx   = product ? `${product}-` : ''
  const cname = configName || 'alertmanager-config'

  let yaml = `apiVersion: monitoring.coreos.com/v1alpha1\nkind: AlertmanagerConfig\n`
  yaml += `metadata:\n  name: ${pfx}${cname}\n`
  yaml += `  labels:\n    app.kubernetes.io/managed-by: Helm\nspec:\n`
  yaml += `  route:\n    receiver: ${JSON.stringify(defaultRecv || 'default')}\n`

  const activeTopMatchers = (routeMatchers || []).filter(m => m.key.trim())
  if (activeTopMatchers.length) {
    yaml += `    matchers:\n`
    for (const m of activeTopMatchers) {
      yaml += `      - name: ${m.key}\n`
      yaml += `        matchType: "${m.op || '='}"\n`
      yaml += `        value: ${JSON.stringify(m.value)}\n`
    }
  }

  const renderedRoutes = precomputedRoutes
    ?? (routeMode === 'pruned' ? pruneRoutes(routeRules, routeMatchers) : routeRules.filter(r => r.receiver && r.matchers.some(m => m.key.trim())))
  if (renderedRoutes.length) {
    yaml += `    routes:\n`
    yaml += renderRouteBlock(renderedRoutes, '      ')
  }

  yaml += `\n  receivers:\n`
  if (embeddedReceivers.length) {
    const embeddedNames = new Set(embeddedReceivers.map(r => r.name))
    for (const rx of embeddedReceivers) yaml += renderReceiverConfig(rx)
    // stub any route receivers not yet embedded
    const routeNames = new Set([defaultRecv, ...routeRules.map(r => r.receiver)].filter(Boolean))
    for (const rn of routeNames) {
      if (!embeddedNames.has(rn)) yaml += `    - name: ${JSON.stringify(rn)}\n`
    }
  } else {
    // no embedded receivers — stubs only
    const recvSet = new Set([defaultRecv, ...routeRules.map(r => r.receiver)].filter(Boolean))
    for (const rn of recvSet) yaml += `    - name: ${JSON.stringify(rn)}\n`
  }

  const activeInhibits = (inhibitRules || []).filter(r =>
    r.sourceMatchers.some(m => m.key.trim()) || r.targetMatchers.some(m => m.key.trim())
  )
  if (activeInhibits.length) {
    yaml += `\n  inhibitRules:\n`
    for (const rule of activeInhibits) {
      const src = rule.sourceMatchers.filter(m => m.key.trim())
      const tgt = rule.targetMatchers.filter(m => m.key.trim())
      yaml += `    - sourceMatch:\n`
      for (const m of src)
        yaml += `        - name: ${m.key}\n          matchType: "${m.op || '='}"\n          value: ${JSON.stringify(m.value)}\n`
      yaml += `      targetMatch:\n`
      for (const m of tgt)
        yaml += `        - name: ${m.key}\n          matchType: "${m.op || '='}"\n          value: ${JSON.stringify(m.value)}\n`
      const eq = (rule.equal || []).filter(e => e.trim())
      if (eq.length) {
        yaml += `      equal:\n`
        for (const e of eq) yaml += `        - ${JSON.stringify(e)}\n`
      }
    }
  }

  return yaml.trimEnd()
}

// ── Sub-components ────────────────────────────────────────────────────────────

const emptyMatcher     = () => ({ key: '', op: '=', value: '' })
const emptyRoute       = () => ({ receiver: '', matchers: [emptyMatcher()] })
const emptyInhibitRule = () => ({ sourceMatchers: [emptyMatcher()], targetMatchers: [emptyMatcher()], equal: [] })

function RouteCard({ route, index, receiverNames, viewableLabels, onChange, onRemove }) {
  function set(f, v) { onChange({ ...route, [f]: v }) }
  function upM(i, f, v) {
    onChange({ ...route, matchers: route.matchers.map((m, idx) => idx === i ? { ...m, [f]: v } : m) })
  }
  function addM()  { onChange({ ...route, matchers: [...route.matchers, emptyMatcher()] }) }
  function delM(i) { onChange({ ...route, matchers: route.matchers.filter((_, idx) => idx !== i) }) }

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: 14, marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Route {index + 1}</span>
        <button className="btn btn-ghost btn-sm" style={{ color: '#ef4444' }} onClick={onRemove}>Remove</button>
      </div>

      <div className="form-row" style={{ marginBottom: 10 }}>
        <label>Receiver</label>
        <input type="text" list={`recv-${index}`} value={route.receiver}
          placeholder="receiver name" onChange={e => set('receiver', e.target.value)} />
        <datalist id={`recv-${index}`}>
          {receiverNames.map(n => <option key={n} value={n} />)}
        </datalist>
      </div>

      <div className="form-row" style={{ marginBottom: 0 }}>
        <label>Matchers
          {viewableLabels.length > 0 && (
            <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400, marginLeft: 6 }}>
              keys from Alert Labels
            </span>
          )}
        </label>
        {route.matchers.length > 0 && (
          <table className="kv-table" style={{ marginBottom: 6 }}>
            <colgroup>
              <col /><col style={{ width: 58 }} /><col /><col style={{ width: 28 }} />
            </colgroup>
            <thead><tr><th>label</th><th>op</th><th>value</th><th /></tr></thead>
            <tbody>
              {route.matchers.map((m, mi) => (
                <tr key={mi}>
                  <td>
                    <input type="text" list={`lbl-${index}-${mi}`} value={m.key}
                      placeholder="label name" onChange={e => upM(mi, 'key', e.target.value)} />
                    {viewableLabels.length > 0 && (
                      <datalist id={`lbl-${index}-${mi}`}>
                        {viewableLabels.map(l => <option key={l} value={l} />)}
                      </datalist>
                    )}
                  </td>
                  <td>
                    <select value={m.op || '='} onChange={e => upM(mi, 'op', e.target.value)}
                      style={{ fontFamily: 'monospace', fontWeight: 700 }}>
                      {MATCHER_OPS.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </td>
                  <td>
                    <input type="text" value={m.value}
                      placeholder={m.op?.includes('~') ? 'regex' : 'value'}
                      onChange={e => upM(mi, 'value', e.target.value)} />
                  </td>
                  <td>
                    <button className="btn btn-ghost btn-icon" onClick={() => delM(mi)}>×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <button className="btn btn-ghost btn-sm" onClick={addM}>+ Add matcher</button>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

const emptyForm = () => ({
  configName:      '',
  defaultReceiver: '',
  groups:          [],
  receivers:       [],
  routeMatchers:   [],
  routeRules:      [emptyRoute()],  // always the flat editable list
  routeMode:       'original',       // 'original' | 'pruned'
  inhibitRules:    [],
})

export default function AlertmanagerSmartEditor() {
  // Template list
  const [templates,      setTemplates]      = useState({})
  const [selected,       setSelected]       = useState(null)   // { name, version }
  const [isNew,          setIsNew]          = useState(false)
  const [modal,          setModal]          = useState(null)
  const [status,         setStatus]         = useState('')

  // Reference data
  const [alertSuites,    setAlertSuites]    = useState({})
  const [receivers,      setReceivers]      = useState({})
  const [product,        setProduct]        = useState('')

  // Form
  const [form,           setForm]           = useState(emptyForm())

  // Loaded group data (keyed by "name@version")
  const [groupDataMap,   setGroupDataMap]   = useState({})

  // Group picker
  const [pickName,           setPickName]           = useState('')
  const [loadingGroup,       setLoadingGroup]       = useState(false)

  // Receiver picker
  const [pickReceiverName,   setPickReceiverName]   = useState('')
  const [loadingReceiver,    setLoadingReceiver]    = useState(false)

  // Server-side pruned route tree (replaces JS pruneRoutes when pruned mode active)
  const [prunedRouteTree,    setPrunedRouteTree]    = useState(null)
  const [pruneLoading,       setPruneLoading]       = useState(false)
  const pruneTimer = useRef(null)

  const load = useCallback(async () => {
    const [tmpl, suites, recvs] = await Promise.all([
      listTemplates(TYPE),
      listTemplates('alert-suite'),
      listTemplates('receivers'),
    ])
    setTemplates(tmpl)
    setAlertSuites(suites)
    setReceivers(recvs)
    try {
      const r = await fetch('/api/defaults')
      const d = await r.json()
      setProduct(d.parsed?.product || '')
    } catch {}
  }, [])
  useEffect(() => { load() }, [load])

  // Debounced call to Python pruning script whenever routes/mode change
  useEffect(() => {
    if (form.routeMode !== 'pruned') { setPrunedRouteTree(null); return }
    clearTimeout(pruneTimer.current)
    pruneTimer.current = setTimeout(async () => {
      setPruneLoading(true)
      const result = await pruneRoutesAPI(form.routeRules, form.routeMatchers)
      setPrunedRouteTree(result?.routeRules ?? null)
      setPruneLoading(false)
    }, 350)
    return () => clearTimeout(pruneTimer.current)
  }, [form.routeMode, form.routeRules, form.routeMatchers])

  async function loadGroupData(name, version) {
    const key = `${name}@${version}`
    if (groupDataMap[key] !== undefined) return  // already loaded
    const result = await getTemplate('alert-suite', name, version)
    const data = result?.parsed?.alertSuite || null
    setGroupDataMap(m => ({ ...m, [key]: data }))
  }

  async function selectVersion(name, version) {
    const data = await getTemplate(TYPE, name, version)
    if (!data) return
    const c = data.parsed || {}
    const groups = (c.groups || [])
    const newForm = {
      configName:      c.configName || name,
      defaultReceiver: c.defaultReceiver || '',
      groups,
      receivers:       c.receivers || [],
      routeMatchers:   c.routeMatchers || [],
      routeRules:      c.flatRouteRules || c.routeRules || [emptyRoute()],
      routeMode:       c.routeMode || 'original',
      inhibitRules:    c.inhibitRules || [],
    }
    setForm(newForm)
    setSelected({ name, version })
    setIsNew(false)
    // Load group data for all groups
    for (const g of groups) {
      loadGroupData(g.name, g.version)
    }
  }

  function startNew() {
    setForm(emptyForm())
    setSelected(null)
    setIsNew(true)
    setPickName('')
  }

  // ── Group add/remove ──────────────────────────────────────────────────────

  async function addGroup() {
    if (!pickName) return
    const vers = alertSuites[pickName] || []
    const ver  = latestVersion(vers) || ''
    if (!ver) return
    const key = `${pickName}@${ver}`
    if (form.groups.some(g => g.name === pickName && g.version === ver)) {
      setPickName('')
      return
    }
    setLoadingGroup(true)
    try {
      const result = await getTemplate('alert-suite', pickName, ver)
      const data = result?.parsed?.alertSuite || null
      setGroupDataMap(m => ({ ...m, [key]: data }))
      setForm(f => ({ ...f, groups: [...f.groups, { name: pickName, version: ver }] }))
      setPickName('')
    } finally {
      setLoadingGroup(false)
    }
  }

  function removeGroup(i) {
    setForm(f => ({ ...f, groups: f.groups.filter((_, idx) => idx !== i) }))
  }

  async function addReceiver() {
    if (!pickReceiverName) return
    if (form.receivers.some(r => r.name === pickReceiverName)) {
      setPickReceiverName(''); return
    }
    const vers = receivers[pickReceiverName] || []
    const ver  = latestVersion(vers) || ''
    if (!ver) return
    setLoadingReceiver(true)
    try {
      const result = await getTemplate('receivers', pickReceiverName, ver)
      if (result?.parsed) {
        setForm(f => ({ ...f, receivers: [...f.receivers, result.parsed] }))
      }
      setPickReceiverName('')
    } finally {
      setLoadingReceiver(false)
    }
  }

  function removeReceiver(i) {
    setForm(f => ({ ...f, receivers: f.receivers.filter((_, idx) => idx !== i) }))
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const viewableLabels = useMemo(() => {
    const set = new Set()
    for (const g of form.groups) {
      const data = groupDataMap[`${g.name}@${g.version}`]
      collectLabels(data, set)
    }
    return [...set].sort()
  }, [form.groups, groupDataMap])

  const receiverNames = form.receivers.map(r => r.name)

  const alertNames = useMemo(() => {
    const names = new Set()
    for (const g of form.groups) {
      const data = groupDataMap[`${g.name}@${g.version}`]
      for (const rule of data?.rules || []) {
        if (rule.ruleName) names.add(rule.ruleName)
      }
    }
    return [...names].sort()
  }, [form.groups, groupDataMap])

  const effectiveRoutes = form.routeMode === 'pruned' && prunedRouteTree ? prunedRouteTree : null

  const preview = useMemo(
    () => buildYAML(form.configName, form.defaultReceiver, form.routeMatchers, form.routeRules, form.receivers, form.inhibitRules, form.routeMode, product, effectiveRoutes),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [form.configName, form.defaultReceiver, form.routeMatchers, form.routeRules, form.receivers, form.inhibitRules, form.routeMode, product, prunedRouteTree]
  )

  // ── Route helpers ─────────────────────────────────────────────────────────

  function addRoute()          { setForm(f => ({ ...f, routeRules: [...f.routeRules, emptyRoute()] })) }
  function removeRoute(i)      { setForm(f => ({ ...f, routeRules: f.routeRules.filter((_, idx) => idx !== i) })) }
  function updateRoute(i, upd) { setForm(f => ({ ...f, routeRules: f.routeRules.map((r, idx) => idx === i ? upd : r) })) }

  // ── Inhibit helpers ───────────────────────────────────────────────────────

  function addInhibit()          { setForm(f => ({ ...f, inhibitRules: [...f.inhibitRules, emptyInhibitRule()] })) }
  function removeInhibit(i)      { setForm(f => ({ ...f, inhibitRules: f.inhibitRules.filter((_, idx) => idx !== i) })) }
  function updateInhibit(i, upd) { setForm(f => ({ ...f, inhibitRules: f.inhibitRules.map((r, idx) => idx === i ? upd : r) })) }

  function updInhibitMatcher(ruleIdx, side, mIdx, field, val) {
    setForm(f => ({
      ...f,
      inhibitRules: f.inhibitRules.map((r, ri) => {
        if (ri !== ruleIdx) return r
        const arr = [...r[side]]
        arr[mIdx] = { ...arr[mIdx], [field]: val }
        return { ...r, [side]: arr }
      }),
    }))
  }
  function addInhibitMatcher(ruleIdx, side) {
    setForm(f => ({
      ...f,
      inhibitRules: f.inhibitRules.map((r, ri) =>
        ri === ruleIdx ? { ...r, [side]: [...r[side], emptyMatcher()] } : r
      ),
    }))
  }
  function delInhibitMatcher(ruleIdx, side, mIdx) {
    setForm(f => ({
      ...f,
      inhibitRules: f.inhibitRules.map((r, ri) =>
        ri === ruleIdx ? { ...r, [side]: r[side].filter((_, i) => i !== mIdx) } : r
      ),
    }))
  }
  function addInhibitEqual(ruleIdx) {
    setForm(f => ({
      ...f,
      inhibitRules: f.inhibitRules.map((r, ri) =>
        ri === ruleIdx ? { ...r, equal: [...r.equal, ''] } : r
      ),
    }))
  }
  function updInhibitEqual(ruleIdx, eIdx, val) {
    setForm(f => ({
      ...f,
      inhibitRules: f.inhibitRules.map((r, ri) =>
        ri === ruleIdx ? { ...r, equal: r.equal.map((e, i) => i === eIdx ? val : e) } : r
      ),
    }))
  }
  function delInhibitEqual(ruleIdx, eIdx) {
    setForm(f => ({
      ...f,
      inhibitRules: f.inhibitRules.map((r, ri) =>
        ri === ruleIdx ? { ...r, equal: r.equal.filter((_, i) => i !== eIdx) } : r
      ),
    }))
  }

  // ── Save / delete ─────────────────────────────────────────────────────────

  function buildPayload() {
    return {
      configName:      form.configName,
      defaultReceiver: form.defaultReceiver,
      groups:          form.groups,
      receivers:       form.receivers,
      routeMatchers:   form.routeMatchers,
      routeMode:       form.routeMode,
      flatRouteRules:  form.routeRules,
      routeRules:      form.routeMode === 'pruned'
        ? (prunedRouteTree ?? pruneRoutes(form.routeRules, form.routeMatchers))
        : form.routeRules.filter(r => r.receiver && r.matchers.some(m => m.key.trim())),
      inhibitRules:    form.inhibitRules,
    }
  }

  async function handleSave(version) {
    setModal(null)
    const name = form.configName.trim() || selected?.name || `amconfig-${Date.now()}`
    await saveTemplate(TYPE, name, version, buildPayload())
    await load()
    setSelected({ name, version })
    setIsNew(false)
    setStatus(`Saved @ ${version}`)
    setTimeout(() => setStatus(''), 2500)
  }

  function openSaveModal() {
    const n = form.configName.trim() || selected?.name
    const v = selected
      ? bumpPatch(selected.version)
      : (n && templates[n] ? bumpPatch(latestVersion(templates[n])) : 'v1.0.0')
    setModal(v)
  }

  async function handleDelete() {
    if (!selected || !confirm(`Delete ${selected.name} @ ${selected.version}?`)) return
    await deleteTemplate(TYPE, selected.name, selected.version)
    setSelected(null)
    setForm(emptyForm())
    setIsNew(false)
    await load()
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const notSelected = !isNew && !selected

  return (
    <div className="editor-layout">

      {/* ── List ── */}
      <div className="editor-list">
        <div className="editor-list-header">
          AM Configs
          <button className="btn btn-primary btn-sm" onClick={startNew}>+ New</button>
        </div>
        <div className="editor-list-body">
          {Object.keys(templates).length === 0 && (
            <div style={{ padding: '20px 14px', color: '#9ca3af', fontSize: 13 }}>No configs yet.</div>
          )}
          {Object.entries(templates).map(([name, versions]) => (
            <div key={name} className="template-group">
              <div className="template-group-name">{name}</div>
              {versions.map(v => (
                <div key={v}
                  className={`template-version${selected?.name === name && selected?.version === v ? ' active' : ''}`}
                  onClick={() => selectVersion(name, v)}>
                  <span className="version-badge">{v}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* ── Form + Preview ── */}
      <div className="editor-form" style={{ display: 'flex', gap: 0, padding: 0, overflow: 'hidden' }}>
        {notSelected ? (
          <div className="empty-state" style={{ flex: 1 }}>
            <div className="empty-state-icon">🔀</div>
            <p>Select a config or click + New.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', width: '100%', height: '100%', overflow: 'hidden' }}>

            {/* ── Left: form ── */}
            <div style={{ flex: 1, overflowY: 'auto', padding: 24, minWidth: 0 }}>

              {/* Identity */}
              <div className="form-card">
                <div className="form-card-title">
                  {selected ? `${selected.name} @ ${selected.version}` : 'New Alertmanager Config'}
                  {status && <span className="tag">{status}</span>}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="form-row" style={{ marginBottom: 0 }}>
                    <label>Config Name *</label>
                    <input type="text" value={form.configName} placeholder="e.g. platform-amconfig"
                      onChange={e => setForm(f => ({ ...f, configName: e.target.value }))} />
                  </div>
                  <div className="form-row" style={{ marginBottom: 0 }}>
                    <label>Default Receiver
                      <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400, marginLeft: 6 }}>catch-all</span>
                    </label>
                    <input type="text" list="am-default-recv" value={form.defaultReceiver}
                      placeholder="receiver name"
                      onChange={e => setForm(f => ({ ...f, defaultReceiver: e.target.value }))} />
                    <datalist id="am-default-recv">
                      {form.receivers.map(r => <option key={r.name} value={r.name} />)}
                    </datalist>
                  </div>
                </div>
              </div>

              {/* Rule Groups */}
              <div className="form-card">
                <div className="form-card-title">Rule Groups
                  <span style={{ fontSize: 11, fontWeight: 400, color: '#9ca3af', marginLeft: 6 }}>
                    select one or more alert suite rule groups
                  </span>
                </div>

                {/* Selected chips */}
                {form.groups.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                    {form.groups.map((g, i) => {
                      const data = groupDataMap[`${g.name}@${g.version}`]
                      return (
                        <span key={i} style={{
                          display: 'inline-flex', alignItems: 'center', gap: 6,
                          background: '#ede9fe', color: '#5b21b6', fontSize: 12,
                          fontFamily: 'monospace', padding: '4px 10px', borderRadius: 4,
                        }}>
                          {g.name}
                          <span style={{ color: '#7c3aed', fontWeight: 400 }}>@{g.version}</span>
                          {data === null && (
                            <span style={{ color: '#ef4444', fontSize: 11 }}> (no data)</span>
                          )}
                          <span style={{ cursor: 'pointer', fontWeight: 700, color: '#7c3aed' }}
                            onClick={() => removeGroup(i)}>×</span>
                        </span>
                      )
                    })}
                  </div>
                )}

                {/* Picker: name only, version auto = latest */}
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                  <div className="form-row" style={{ marginBottom: 0, flex: 1 }}>
                    <label>Add Rule Group</label>
                    <select value={pickName} onChange={e => setPickName(e.target.value)}>
                      <option value="">— select —</option>
                      {Object.keys(alertSuites)
                        .filter(n => {
                          const ver = latestVersion(alertSuites[n] || []) || ''
                          return !form.groups.some(g => g.name === n && g.version === ver)
                        })
                        .map(n => {
                          const ver = latestVersion(alertSuites[n] || []) || ''
                          return (
                            <option key={n} value={n}>
                              {n}{ver ? ` (${ver})` : ''}
                            </option>
                          )
                        })}
                    </select>
                  </div>
                  <button className="btn btn-secondary btn-sm"
                    style={{ marginBottom: 0, whiteSpace: 'nowrap', alignSelf: 'flex-end' }}
                    disabled={!pickName || loadingGroup}
                    onClick={addGroup}>
                    {loadingGroup ? 'Loading…' : '+ Add'}
                  </button>
                </div>
              </div>

              {/* Receivers */}
              <div className="form-card">
                <div className="form-card-title">Receivers
                  <span style={{ fontSize: 11, fontWeight: 400, color: '#9ca3af', marginLeft: 6 }}>
                    select receiver templates — configs will be embedded in the rendered output
                  </span>
                </div>

                {form.receivers.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                    {form.receivers.map((rx, i) => (
                      <span key={i} style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        background: '#fef3c7', color: '#92400e', fontSize: 12,
                        fontFamily: 'monospace', padding: '4px 10px', borderRadius: 4,
                      }}>
                        {rx.name}
                        <span style={{ cursor: 'pointer', fontWeight: 700, color: '#b45309' }}
                          onClick={() => removeReceiver(i)}>×</span>
                      </span>
                    ))}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                  <div className="form-row" style={{ marginBottom: 0, flex: 1 }}>
                    <label>Add Receiver</label>
                    <select value={pickReceiverName} onChange={e => setPickReceiverName(e.target.value)}>
                      <option value="">— select —</option>
                      {Object.keys(receivers)
                        .filter(n => !form.receivers.some(r => r.name === n))
                        .map(n => {
                          const ver = latestVersion(receivers[n] || []) || ''
                          return <option key={n} value={n}>{n}{ver ? ` (${ver})` : ''}</option>
                        })}
                    </select>
                  </div>
                  <button className="btn btn-secondary btn-sm"
                    style={{ marginBottom: 0, whiteSpace: 'nowrap', alignSelf: 'flex-end' }}
                    disabled={!pickReceiverName || loadingReceiver}
                    onClick={addReceiver}>
                    {loadingReceiver ? 'Loading…' : '+ Add'}
                  </button>
                </div>
              </div>

              {/* Alert Labels */}
              <div className="form-card">
                <div className="form-card-title">Alert Labels
                  <span style={{ fontSize: 11, fontWeight: 400, color: '#9ca3af', marginLeft: 6 }}>
                    labels carried by fired alerts — use these as route matcher keys
                  </span>
                </div>

                {form.groups.length === 0 ? (
                  <p className="text-muted">Add at least one rule group above.</p>
                ) : viewableLabels.length === 0 ? (
                  <p className="text-muted">No labels detected.</p>
                ) : (
                  <>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                      {viewableLabels.map(lbl => (
                        <span key={lbl} style={{
                          background: '#e0e7ff', color: '#4338ca', fontSize: 12,
                          fontFamily: 'monospace', padding: '3px 10px', borderRadius: 4,
                        }}>
                          {lbl}
                        </span>
                      ))}
                    </div>

                    {form.groups.some(g => groupDataMap[`${g.name}@${g.version}`]) && (
                      <details>
                        <summary style={{ fontSize: 12, color: '#6b7280', cursor: 'pointer' }}>
                          Per-group breakdown
                        </summary>
                        {form.groups.map((g, gi) => {
                          const data = groupDataMap[`${g.name}@${g.version}`]
                          if (!data) return null
                          const groupLabelEntries = Object.entries(data.groupLabels || {})
                          return (
                            <div key={gi} style={{ marginTop: 8 }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: '#6366f1', marginBottom: 4 }}>
                                {g.name}@{g.version}
                              </div>

                              {/* Group-level labels */}
                              {groupLabelEntries.length > 0 && (
                                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
                                  <span style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' }}>group labels:</span>
                                  {groupLabelEntries.map(([k, v]) => (
                                    <span key={k} style={{
                                      fontSize: 11, fontFamily: 'monospace',
                                      background: '#f0fdf4', color: '#166534',
                                      padding: '2px 7px', borderRadius: 3,
                                    }}>
                                      {k}: {v}
                                    </span>
                                  ))}
                                </div>
                              )}

                              <table className="kv-table">
                                <thead>
                                  <tr><th>Rule</th><th>Severity</th><th>Rule Labels</th><th>PromQL by()</th></tr>
                                </thead>
                                <tbody>
                                  {(data.rules || []).map((rule, ri) => {
                                    const expr = rule.expr || rule.vars?.expr || ''
                                    const byLabels = []
                                    for (const m of [...expr.matchAll(/\bby\s*\(([^)]+)\)/gi)]) {
                                      for (const l of m[1].split(',').map(s => s.trim()).filter(Boolean)) byLabels.push(l)
                                    }
                                    return (
                                      <tr key={ri}>
                                        <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{rule.ruleName || `rule-${ri + 1}`}</td>
                                        <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{rule.severity || '—'}</td>
                                        <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{Object.keys(rule.labels || {}).join(', ') || '—'}</td>
                                        <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{byLabels.join(', ') || '—'}</td>
                                      </tr>
                                    )
                                  })}
                                </tbody>
                              </table>
                            </div>
                          )
                        })}
                      </details>
                    )}
                  </>
                )}
              </div>

              {/* Route Matchers (top-level) */}
              <div className="form-card">
                <div className="form-card-title">
                  Route Matchers
                  <span style={{ fontSize: 11, fontWeight: 400, color: '#9ca3af', marginLeft: 6 }}>
                    spec.route.matchers — only alerts matching these are handled by this config
                  </span>
                  <button className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }}
                    onClick={() => setForm(f => ({ ...f, routeMatchers: [...f.routeMatchers, emptyMatcher()] }))}>
                    + Add
                  </button>
                </div>
                {form.routeMatchers.length === 0 ? (
                  <p className="text-muted" style={{ fontSize: 12 }}>No top-level matchers — this config handles all alerts.</p>
                ) : (
                  <table className="kv-table" style={{ marginBottom: 0 }}>
                    <colgroup>
                      <col /><col style={{ width: 58 }} /><col /><col style={{ width: 28 }} />
                    </colgroup>
                    <thead><tr><th>label</th><th>op</th><th>value</th><th /></tr></thead>
                    <tbody>
                      {form.routeMatchers.map((m, mi) => (
                        <tr key={mi}>
                          <td>
                            <input type="text" list="rm-lbl" value={m.key}
                              placeholder="label name" onChange={e =>
                                setForm(f => ({ ...f, routeMatchers: f.routeMatchers.map((x, i) => i === mi ? { ...x, key: e.target.value } : x) }))} />
                            {viewableLabels.length > 0 && (
                              <datalist id="rm-lbl">
                                {viewableLabels.map(l => <option key={l} value={l} />)}
                              </datalist>
                            )}
                          </td>
                          <td>
                            <select value={m.op || '='} style={{ fontFamily: 'monospace', fontWeight: 700 }}
                              onChange={e =>
                                setForm(f => ({ ...f, routeMatchers: f.routeMatchers.map((x, i) => i === mi ? { ...x, op: e.target.value } : x) }))}>
                              {MATCHER_OPS.map(o => <option key={o} value={o}>{o}</option>)}
                            </select>
                          </td>
                          <td>
                            <input type="text" value={m.value}
                              placeholder={m.op?.includes('~') ? 'regex' : 'value'}
                              onChange={e =>
                                setForm(f => ({ ...f, routeMatchers: f.routeMatchers.map((x, i) => i === mi ? { ...x, value: e.target.value } : x) }))} />
                          </td>
                          <td>
                            <button className="btn btn-ghost btn-icon"
                              onClick={() => setForm(f => ({ ...f, routeMatchers: f.routeMatchers.filter((_, i) => i !== mi) }))}>×</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {/* Route Configuration */}
              <div className="form-card">
                <div className="form-card-title">
                  Route Configuration
                  <div style={{ display: 'flex', borderRadius: 5, overflow: 'hidden', border: '1px solid #d1d5db', fontSize: 11, marginLeft: 8 }}>
                    {[['original', 'Original'], ['pruned', 'Pruned']].map(([mode, label]) => (
                      <button key={mode} style={{
                        padding: '2px 10px', border: 'none', cursor: 'pointer', fontWeight: 600,
                        background: form.routeMode === mode ? '#6366f1' : '#fff',
                        color: form.routeMode === mode ? '#fff' : '#6b7280',
                      }} onClick={() => setForm(f => ({ ...f, routeMode: mode }))}>
                        {label}
                      </button>
                    ))}
                  </div>
                  {form.routeMode === 'pruned' && (
                    <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400, marginLeft: 6 }}>
                      shared matchers merged into parent routes
                    </span>
                  )}
                  <button className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }} onClick={addRoute}>+ Add Route</button>
                </div>
                {form.routeRules.length === 0 && <p className="text-muted">No routes. Click + Add Route.</p>}
                {form.routeRules.map((route, ri) => (
                  <RouteCard key={ri} route={route} index={ri}
                    receiverNames={receiverNames}
                    viewableLabels={viewableLabels}
                    onChange={upd => updateRoute(ri, upd)}
                    onRemove={() => removeRoute(ri)} />
                ))}
              </div>

              {/* Inhibit Rules */}
              <div className="form-card">
                <div className="form-card-title">
                  Inhibit Rules
                  <span style={{ fontSize: 11, fontWeight: 400, color: '#9ca3af', marginLeft: 6 }}>
                    spec.inhibitRules — source alert suppresses target alert
                  </span>
                  <button className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }} onClick={addInhibit}>
                    + Add
                  </button>
                </div>
                {form.inhibitRules.length === 0 && (
                  <p className="text-muted" style={{ fontSize: 12 }}>No inhibit rules.</p>
                )}
                {form.inhibitRules.map((rule, ri) => (
                  <div key={ri} style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: 12, marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>Inhibit Rule {ri + 1}</span>
                      <button className="btn btn-ghost btn-sm" style={{ color: '#ef4444' }} onClick={() => removeInhibit(ri)}>Remove</button>
                    </div>

                    {[['sourceMatchers', 'Source (firing)'], ['targetMatchers', 'Target (suppressed)']].map(([side, label]) => (
                      <div key={side} style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 4 }}>{label}</div>
                        <table className="kv-table" style={{ marginBottom: 4 }}>
                          <colgroup><col /><col style={{ width: 58 }} /><col /><col style={{ width: 28 }} /></colgroup>
                          <thead><tr><th>label</th><th>op</th><th>value</th><th /></tr></thead>
                          <tbody>
                            {rule[side].map((m, mi) => (
                              <tr key={mi}>
                                <td>
                                  <input type="text" list={`inh-${ri}-${side}-lbl`} value={m.key}
                                    placeholder="alertname / label"
                                    onChange={e => updInhibitMatcher(ri, side, mi, 'key', e.target.value)} />
                                  <datalist id={`inh-${ri}-${side}-lbl`}>
                                    <option value="alertname" />
                                    <option value="severity" />
                                    {alertNames.map(n => <option key={n} value={n} />)}
                                    {viewableLabels.filter(l => l !== 'alertname' && l !== 'severity').map(l => <option key={l} value={l} />)}
                                  </datalist>
                                </td>
                                <td>
                                  <select value={m.op || '='} style={{ fontFamily: 'monospace', fontWeight: 700 }}
                                    onChange={e => updInhibitMatcher(ri, side, mi, 'op', e.target.value)}>
                                    {MATCHER_OPS.map(o => <option key={o} value={o}>{o}</option>)}
                                  </select>
                                </td>
                                <td>
                                  <input type="text" list={`inh-${ri}-${side}-val-${mi}`} value={m.value}
                                    placeholder={m.op?.includes('~') ? 'regex' : 'value'}
                                    onChange={e => updInhibitMatcher(ri, side, mi, 'value', e.target.value)} />
                                  {m.key === 'alertname' && (
                                    <datalist id={`inh-${ri}-${side}-val-${mi}`}>
                                      {alertNames.map(n => <option key={n} value={n} />)}
                                    </datalist>
                                  )}
                                  {m.key === 'severity' && (
                                    <datalist id={`inh-${ri}-${side}-val-${mi}`}>
                                      {['critical', 'warning', 'info'].map(s => <option key={s} value={s} />)}
                                    </datalist>
                                  )}
                                </td>
                                <td>
                                  <button className="btn btn-ghost btn-icon"
                                    onClick={() => delInhibitMatcher(ri, side, mi)}>×</button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <button className="btn btn-ghost btn-sm"
                          onClick={() => addInhibitMatcher(ri, side)}>+ Add matcher</button>
                      </div>
                    ))}

                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 4 }}>
                        Equal Labels
                        <span style={{ fontWeight: 400, color: '#9ca3af', marginLeft: 6 }}>
                          must match between source and target
                        </span>
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                        {rule.equal.map((e, ei) => (
                          <span key={ei} style={{ display: 'inline-flex', alignItems: 'center', gap: 4,
                            background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 4,
                            padding: '2px 6px', fontSize: 12, fontFamily: 'monospace' }}>
                            <input type="text" list="inh-equal-lbl" value={e}
                              placeholder="label name"
                              style={{ border: 'none', background: 'transparent', fontFamily: 'monospace',
                                fontSize: 12, width: Math.max(60, e.length * 8 + 16), padding: 0 }}
                              onChange={ev => updInhibitEqual(ri, ei, ev.target.value)} />
                            <button style={{ border: 'none', background: 'none', cursor: 'pointer',
                              color: '#16a34a', fontWeight: 700, padding: 0, lineHeight: 1 }}
                              onClick={() => delInhibitEqual(ri, ei)}>×</button>
                          </span>
                        ))}
                        <datalist id="inh-equal-lbl">
                          <option value="alertname" />
                          {viewableLabels.map(l => <option key={l} value={l} />)}
                        </datalist>
                        <button className="btn btn-ghost btn-sm" onClick={() => addInhibitEqual(ri)}>+ Add</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="btn-row">
                <button className="btn btn-primary" onClick={openSaveModal}>Save as Version…</button>
                {selected && (
                  <button className="btn btn-danger" onClick={handleDelete}>Delete this version</button>
                )}
              </div>
            </div>

            {/* ── Right: YAML preview ── */}
            <div style={{
              width: 400, minWidth: 320, borderLeft: '1px solid #e5e7eb',
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
            }}>
              <div style={{
                padding: '10px 16px', borderBottom: '1px solid #e5e7eb',
                fontSize: 12, fontWeight: 600, color: '#6b7280',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                <span>
                  YAML Preview
                  {form.routeMode === 'pruned' && (
                    pruneLoading
                      ? <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400, marginLeft: 8 }}>pruning…</span>
                      : prunedRouteTree
                        ? <span style={{ fontSize: 11, color: '#10b981', fontWeight: 400, marginLeft: 8 }}>
                            pruned · {form.routeRules.filter(r=>r.receiver).length} → {prunedRouteTree.length} top-level
                          </span>
                        : null
                  )}
                </span>
                {product && <span style={{ fontSize: 11, color: '#9ca3af' }}>product: {product}</span>}
              </div>
              <pre style={{
                flex: 1, overflowY: 'auto', margin: 0, padding: '14px 16px',
                fontSize: 11.5, fontFamily: "'Fira Code', 'Cascadia Code', monospace",
                background: '#0f172a', color: '#7dd3fc', lineHeight: 1.7,
                whiteSpace: 'pre', overflowX: 'auto',
              }}>
                {preview}
              </pre>
            </div>
          </div>
        )}
      </div>

      {modal && <VersionModal defaultVersion={modal} onSave={handleSave} onCancel={() => setModal(null)} />}
    </div>
  )
}
