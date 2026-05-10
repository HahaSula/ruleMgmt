import { useState, useEffect, useCallback, useMemo } from 'react'
import VersionModal from '../components/VersionModal'
import KVEditor from '../components/KVEditor'
import { listTemplates, getTemplate, saveTemplate, deleteTemplate } from '../utils/api'
import { bumpPatch, latestVersion } from '../utils/templateUtils'

const TYPE = 'amconfig'

// ── YAML preview builder ──────────────────────────────────────────────────────

function indent(str, n) {
  const pad = ' '.repeat(n)
  return str.split('\n').map(l => pad + l).join('\n')
}

function buildPreview(form, product) {
  const pfx = product ? `${product}-` : ''
  const name = form.configName || 'my-alertmanager-config'

  let yaml = `apiVersion: monitoring.coreos.com/v1alpha1\nkind: AlertmanagerConfig\nmetadata:\n  name: ${pfx}${name}\n  labels:\n    app.kubernetes.io/managed-by: Helm\nspec:\n`

  // route
  yaml += `  route:\n`
  yaml += `    receiver: ${JSON.stringify(form.defaultReceiver || 'default')}\n`
  const topMatchers = (form.routeMatchers || []).filter(m => m.key.trim())
  if (topMatchers.length) {
    yaml += `    matchers:\n`
    for (const m of topMatchers) {
      yaml += `      - name: ${m.key}\n        matchType: "${m.op || '='}"\n        value: ${JSON.stringify(m.value)}\n`
    }
  }
  if (form.groupBy.length) {
    yaml += `    groupBy:\n` + form.groupBy.map(l => `      - ${l}`).join('\n') + '\n'
  }
  yaml += `    groupWait: ${form.groupWait || '30s'}\n`
  yaml += `    groupInterval: ${form.groupInterval || '5m'}\n`
  yaml += `    repeatInterval: ${form.repeatInterval || '12h'}\n`

  if (form.routes.length) {
    yaml += `    routes:\n`
    for (const r of form.routes) {
      yaml += `      - receiver: ${JSON.stringify(r.receiver || 'default')}\n`
      if (r.matchers.filter(m => m.key.trim()).length) {
        yaml += `        matchers:\n`
        for (const m of r.matchers.filter(m => m.key.trim())) {
          yaml += `          - name: ${m.key}\n            matchType: "${m.op || '='}"\n            value: ${JSON.stringify(m.value)}\n`
        }
      }
      if (r.continue) yaml += `        continue: true\n`
    }
  }

  // receivers placeholder
  const receiverSet = new Set([form.defaultReceiver, ...form.routes.map(r => r.receiver)].filter(Boolean))
  if (receiverSet.size) {
    yaml += `\n  receivers:\n`
    for (const rn of receiverSet) {
      yaml += `    - name: ${JSON.stringify(rn)}\n`
    }
  }

  // inhibit rules
  if (form.inhibitRules.filter(r => r.sourceMatch.trim() || r.targetMatch.trim()).length) {
    yaml += `\n  inhibitRules:\n`
    for (const r of form.inhibitRules) {
      if (!r.sourceMatch.trim() && !r.targetMatch.trim()) continue
      yaml += `    - sourceMatch:\n        - name: alertname\n          value: ${JSON.stringify(r.sourceMatch)}\n`
      yaml += `      targetMatch:\n        - name: alertname\n          value: ${JSON.stringify(r.targetMatch)}\n`
      if (r.equal) yaml += `      equal:\n` + r.equal.split(',').map(e => `        - ${e.trim()}`).join('\n') + '\n'
    }
  }

  return yaml.trimEnd()
}

// ── State ─────────────────────────────────────────────────────────────────────

const MATCHER_OPS = ['=', '!=', '=~', '!~']
const emptyMatcher = () => ({ key: '', op: '=', value: '' })
const emptyRoute   = () => ({ receiver: '', matchers: [], continue: false })
const emptyInhibit = () => ({ sourceMatch: '', targetMatch: '', equal: 'namespace' })

const emptyForm = () => ({
  configName:      '',
  groupBy:         [],        // string[]
  groupWait:       '30s',
  groupInterval:   '5m',
  repeatInterval:  '12h',
  defaultReceiver: '',
  routeMatchers:   [],        // top-level spec.route matchers
  routes:          [],
  inhibitRules:    [],
})

// ── GroupBy tag editor ────────────────────────────────────────────────────────

function TagListEditor({ tags, onChange, placeholder }) {
  const [input, setInput] = useState('')
  function add() {
    const v = input.trim()
    if (v && !tags.includes(v)) { onChange([...tags, v]); setInput('') }
  }
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
        {tags.map(t => (
          <span key={t} style={{
            background: '#e0e7ff', color: '#4338ca', fontSize: 12, fontFamily: 'monospace',
            padding: '2px 8px', borderRadius: 4, display: 'inline-flex', alignItems: 'center', gap: 4,
          }}>
            {t}
            <span style={{ cursor: 'pointer', fontWeight: 700 }}
              onClick={() => onChange(tags.filter(x => x !== t))}>×</span>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input type="text" value={input} placeholder={placeholder || 'label name'}
          style={{ flex: 1 }}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && add()} />
        <button className="btn btn-ghost btn-sm" onClick={add}>+ Add</button>
      </div>
    </div>
  )
}

// ── Matchers editor (key / op / value rows) ───────────────────────────────────

function MatchersEditor({ matchers, onChange }) {
  function update(i, field, val) {
    onChange(matchers.map((m, idx) => idx === i ? { ...m, [field]: val } : m))
  }
  return (
    <div>
      {matchers.length > 0 && (
        <table className="kv-table" style={{ marginBottom: 4 }}>
          <colgroup>
            <col /><col style={{ width: 54 }} /><col /><col style={{ width: 28 }} />
          </colgroup>
          <thead><tr><th>label</th><th>op</th><th>value</th><th></th></tr></thead>
          <tbody>
            {matchers.map((m, i) => (
              <tr key={i}>
                <td><input type="text" value={m.key} placeholder="label name"
                  onChange={e => update(i, 'key', e.target.value)} /></td>
                <td>
                  <select value={m.op || '='} onChange={e => update(i, 'op', e.target.value)}
                    style={{ fontFamily: 'monospace', fontWeight: 700 }}>
                    {MATCHER_OPS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </td>
                <td><input type="text" value={m.value}
                  placeholder={m.op?.includes('~') ? 'regex' : 'value'}
                  onChange={e => update(i, 'value', e.target.value)} /></td>
                <td>
                  <button className="btn btn-ghost btn-icon"
                    onClick={() => onChange(matchers.filter((_, idx) => idx !== i))}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button className="btn btn-ghost btn-sm"
        onClick={() => onChange([...matchers, emptyMatcher()])}>+ Add matcher</button>
    </div>
  )
}

// ── Route card ────────────────────────────────────────────────────────────────

function RouteCard({ route, index, receiverNames, onChange, onRemove }) {
  function set(field, val) { onChange({ ...route, [field]: val }) }
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: 12, marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Route {index + 1}</span>
        <button className="btn btn-ghost btn-sm" style={{ color: '#ef4444' }} onClick={onRemove}>Remove</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, marginBottom: 8 }}>
        <div className="form-row" style={{ marginBottom: 0 }}>
          <label>Receiver *</label>
          <input type="text" list={`route-recv-${index}`} value={route.receiver}
            placeholder="receiver name"
            onChange={e => set('receiver', e.target.value)} />
          <datalist id={`route-recv-${index}`}>
            {receiverNames.map(n => <option key={n} value={n} />)}
          </datalist>
        </div>
        <div className="form-row" style={{ marginBottom: 0, paddingTop: 18 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={!!route.continue}
              onChange={e => set('continue', e.target.checked)} />
            <span style={{ fontSize: 12 }}>continue</span>
          </label>
        </div>
      </div>

      <div className="form-row" style={{ marginBottom: 0 }}>
        <label>Matchers</label>
        <MatchersEditor matchers={route.matchers} onChange={rows => set('matchers', rows)} />
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AlertmanagerConfigEditor() {
  const [templates, setTemplates] = useState({})
  const [receivers, setReceivers] = useState({})
  const [selected, setSelected]   = useState(null)
  const [form, setForm]           = useState(emptyForm())
  const [isNew, setIsNew]         = useState(false)
  const [modal, setModal]         = useState(null)
  const [status, setStatus]       = useState('')
  const [product, setProduct]     = useState('')

  const load = useCallback(async () => {
    const [cfgs, recvs] = await Promise.all([
      listTemplates(TYPE),
      listTemplates('receivers'),
    ])
    setTemplates(cfgs)
    setReceivers(recvs)
    // read product from defaults
    try {
      const r = await fetch('/api/defaults')
      const d = await r.json()
      setProduct(d.parsed?.product || '')
    } catch {}
  }, [])
  useEffect(() => { load() }, [load])

  async function selectVersion(name, version) {
    const data = await getTemplate(TYPE, name, version)
    if (!data) return
    const c = data.parsed || {}
    setForm({
      configName:      c.configName      || name,
      groupBy:         c.groupBy         || [],
      groupWait:       c.groupWait       || '30s',
      groupInterval:   c.groupInterval   || '5m',
      repeatInterval:  c.repeatInterval  || '12h',
      defaultReceiver: c.defaultReceiver || '',
      routeMatchers: (c.routeMatchers || []).map(m => ({
        key: m.name || m.key || '', op: m.matchType || m.op || '=', value: m.value || '',
      })),
      routes: (c.routes || []).map(r => ({
        receiver: r.receiver || '',
        matchers: (r.matchers || []).map(m => ({
          key: m.name || m.key || '', op: m.matchType || m.op || '=', value: m.value || '',
        })),
        continue: !!r.continue,
      })),
      inhibitRules: (c.inhibitRules || []).map(r => ({
        sourceMatch: r.sourceMatch || '',
        targetMatch: r.targetMatch || '',
        equal:       Array.isArray(r.equal) ? r.equal.join(', ') : (r.equal || 'namespace'),
      })),
    })
    setSelected({ name, version })
    setIsNew(false)
  }

  function startNew() { setForm(emptyForm()); setSelected(null); setIsNew(true) }

  const receiverNames = Object.keys(receivers)

  function addRoute()     { setForm(f => ({ ...f, routes: [...f.routes, emptyRoute()] })) }
  function removeRoute(i) { setForm(f => ({ ...f, routes: f.routes.filter((_, idx) => idx !== i) })) }
  function updateRoute(i, updated) {
    setForm(f => ({ ...f, routes: f.routes.map((r, idx) => idx === i ? updated : r) }))
  }

  function addInhibit()     { setForm(f => ({ ...f, inhibitRules: [...f.inhibitRules, emptyInhibit()] })) }
  function removeInhibit(i) { setForm(f => ({ ...f, inhibitRules: f.inhibitRules.filter((_, idx) => idx !== i) })) }
  function updateInhibit(i, field, val) {
    setForm(f => ({ ...f, inhibitRules: f.inhibitRules.map((r, idx) => idx === i ? { ...r, [field]: val } : r) }))
  }

  function buildPayload() {
    return {
      configName:      form.configName,
      groupBy:         form.groupBy,
      groupWait:       form.groupWait,
      groupInterval:   form.groupInterval,
      repeatInterval:  form.repeatInterval,
      defaultReceiver: form.defaultReceiver,
      routeMatchers: form.routeMatchers.filter(m => m.key.trim())
        .map(m => ({ name: m.key, matchType: m.op || '=', value: m.value })),
      routes: form.routes.map(r => ({
        receiver: r.receiver,
        matchers: r.matchers.filter(m => m.key.trim())
          .map(m => ({ name: m.key, matchType: m.op || '=', value: m.value })),
        ...(r.continue && { continue: true }),
      })),
      inhibitRules: form.inhibitRules
        .filter(r => r.sourceMatch.trim() || r.targetMatch.trim())
        .map(r => ({
          sourceMatch: r.sourceMatch,
          targetMatch: r.targetMatch,
          equal: r.equal.split(',').map(e => e.trim()).filter(Boolean),
        })),
    }
  }

  async function handleSave(name, version) {
    setModal(null)
    const instanceName = name || `amconfig-${Date.now()}`
    await saveTemplate(TYPE, instanceName, version, buildPayload())
    await load()
    setSelected({ name: instanceName, version })
    setIsNew(false)
    setStatus(`Saved @ ${version}`)
    setTimeout(() => setStatus(''), 2500)
  }

  function openSaveModal() {
    const n = form.configName?.trim() || selected?.name || ''
    const v = selected
      ? bumpPatch(selected.version)
      : (n && templates[n] ? bumpPatch(latestVersion(templates[n])) : 'v1.0.0')
    setModal({ name: n, version: v })
  }

  async function handleDelete() {
    if (!selected || !confirm(`Delete ${selected.name} @ ${selected.version}?`)) return
    await deleteTemplate(TYPE, selected.name, selected.version)
    setSelected(null); setForm(emptyForm()); setIsNew(false)
    await load()
  }

  const preview = useMemo(() => buildPreview(form, product), [form, product])

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

        {!isNew && !selected ? (
          <div className="empty-state" style={{ flex: 1 }}>
            <div className="empty-state-icon">🔀</div>
            <p>Select a config or click + New.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', width: '100%', height: '100%', overflow: 'hidden' }}>

            {/* left: editor */}
            <div style={{ flex: 1, overflowY: 'auto', padding: 24, minWidth: 0 }}>
              {/* Identity */}
              <div className="form-card">
                <div className="form-card-title">
                  {selected ? `${selected.name} @ ${selected.version}` : 'New Alertmanager Config'}
                  {status && <span className="tag">{status}</span>}
                </div>
                <div className="form-row" style={{ marginBottom: 0 }}>
                  <label>Config Name *</label>
                  <input type="text" value={form.configName} placeholder="e.g. platform-config"
                    onChange={e => setForm(f => ({ ...f, configName: e.target.value }))} />
                </div>
              </div>

              {/* Route config */}
              <div className="form-card">
                <div className="form-card-title">Route Settings</div>
                <div className="form-row">
                  <label>Receiver *</label>
                  <input type="text" list="default-recv-route" value={form.defaultReceiver}
                    placeholder="receiver name"
                    onChange={e => setForm(f => ({ ...f, defaultReceiver: e.target.value }))} />
                  <datalist id="default-recv-route">
                    {receiverNames.map(n => <option key={n} value={n} />)}
                  </datalist>
                </div>
                <div className="form-row">
                  <label>Matchers
                    <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400, marginLeft: 6 }}>
                      top-level route matchers (spec.route.matchers)
                    </span>
                  </label>
                  <MatchersEditor matchers={form.routeMatchers}
                    onChange={rows => setForm(f => ({ ...f, routeMatchers: rows }))} />
                </div>
                <div className="form-row">
                  <label>Group By
                    <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400, marginLeft: 6 }}>
                      press Enter or click + Add
                    </span>
                  </label>
                  <TagListEditor tags={form.groupBy}
                    onChange={tags => setForm(f => ({ ...f, groupBy: tags }))}
                    placeholder="label name (e.g. alertname)" />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginTop: 4 }}>
                  <div className="form-row" style={{ marginBottom: 0 }}>
                    <label>Group Wait</label>
                    <input type="text" value={form.groupWait} placeholder="30s"
                      onChange={e => setForm(f => ({ ...f, groupWait: e.target.value }))} />
                  </div>
                  <div className="form-row" style={{ marginBottom: 0 }}>
                    <label>Group Interval</label>
                    <input type="text" value={form.groupInterval} placeholder="5m"
                      onChange={e => setForm(f => ({ ...f, groupInterval: e.target.value }))} />
                  </div>
                  <div className="form-row" style={{ marginBottom: 0 }}>
                    <label>Repeat Interval</label>
                    <input type="text" value={form.repeatInterval} placeholder="12h"
                      onChange={e => setForm(f => ({ ...f, repeatInterval: e.target.value }))} />
                  </div>
                </div>
              </div>

              {/* Sub-routes */}
              <div className="form-card">
                <div className="form-card-title">
                  Sub-Routes
                  <button className="btn btn-secondary btn-sm" onClick={addRoute}>+ Add Route</button>
                </div>
                {form.routes.length === 0 && <p className="text-muted">No sub-routes.</p>}
                {form.routes.map((r, i) => (
                  <RouteCard key={i} route={r} index={i} receiverNames={receiverNames}
                    onChange={updated => updateRoute(i, updated)}
                    onRemove={() => removeRoute(i)} />
                ))}
              </div>

              {/* Inhibit rules */}
              <div className="form-card">
                <div className="form-card-title">
                  Inhibit Rules
                  <button className="btn btn-secondary btn-sm" onClick={addInhibit}>+ Add</button>
                </div>
                <p className="text-muted" style={{ marginBottom: 8 }}>Source suppresses target.</p>
                {form.inhibitRules.length === 0 && <p className="text-muted">No inhibit rules.</p>}
                {form.inhibitRules.map((r, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 32px', gap: 8, marginBottom: 8 }}>
                    <div className="form-row" style={{ marginBottom: 0 }}>
                      <label>Source alertname</label>
                      <input type="text" value={r.sourceMatch} placeholder="HighCPU"
                        onChange={e => updateInhibit(i, 'sourceMatch', e.target.value)} />
                    </div>
                    <div className="form-row" style={{ marginBottom: 0 }}>
                      <label>Target alertname</label>
                      <input type="text" value={r.targetMatch} placeholder="HighMemory"
                        onChange={e => updateInhibit(i, 'targetMatch', e.target.value)} />
                    </div>
                    <div className="form-row" style={{ marginBottom: 0 }}>
                      <label>Equal labels</label>
                      <input type="text" value={r.equal} placeholder="namespace, pod"
                        onChange={e => updateInhibit(i, 'equal', e.target.value)} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                      <button className="btn btn-ghost btn-icon" onClick={() => removeInhibit(i)}>×</button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="btn-row">
                <button className="btn btn-primary" onClick={openSaveModal}>Save as Version…</button>
                {selected && <button className="btn btn-danger" onClick={handleDelete}>Delete this version</button>}
              </div>
            </div>

            {/* right: YAML preview */}
            <div style={{
              width: 380, minWidth: 320, borderLeft: '1px solid #e5e7eb',
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
            }}>
              <div style={{
                padding: '10px 16px', borderBottom: '1px solid #e5e7eb',
                fontSize: 12, fontWeight: 600, color: '#6b7280',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                YAML Preview
                {product && (
                  <span style={{ fontSize: 11, color: '#9ca3af' }}>product: {product}</span>
                )}
              </div>
              <pre style={{
                flex: 1, overflowY: 'auto', margin: 0,
                padding: '14px 16px', fontSize: 11.5,
                fontFamily: "'Fira Code', 'Cascadia Code', monospace",
                background: '#0f172a', color: '#7dd3fc', lineHeight: 1.7,
                whiteSpace: 'pre', overflowX: 'auto',
              }}>
                {preview}
              </pre>
            </div>
          </div>
        )}
      </div>

      {modal && <VersionModal defaultName={modal.name} defaultVersion={modal.version} onSave={handleSave} onCancel={() => setModal(null)} />}
    </div>
  )
}
