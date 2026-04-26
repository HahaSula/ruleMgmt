import { useState, useEffect, useCallback, useRef } from 'react'
import KVEditor from '../components/KVEditor'
import VersionModal from '../components/VersionModal'
import { listTemplates, getTemplate, saveTemplate, deleteTemplate } from '../utils/api'
import { kvArrayToObject, objectToKvArray, bumpPatch, latestVersion } from '../utils/templateUtils'

const TYPE = 'alert-suite'
const SEVERITIES  = ['critical', 'warning', 'info', 'none']
const OP_OPTIONS  = ['>', '<', '>=', '<=', '==', '!=']
const FUNC_OPTIONS = ['rate', 'irate', 'increase', 'avg_over_time', 'max_over_time', 'min_over_time']

// ── Metrics input: metric_name + label KV editor ─────────────────────────────

function parseMetric(s) {
  const m = (s || '').match(/^([^{]*)(?:\{(.*)\})?$/)
  const name = m?.[1]?.trim() || ''
  const labelsStr = m?.[2]?.trim() || ''
  const labels = labelsStr
    ? labelsStr.split(',').map(pair => {
        const eq = pair.indexOf('=')
        if (eq === -1) return { key: pair.trim(), value: '' }
        return { key: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).replace(/^["']|["']$/g, '').trim() }
      }).filter(p => p.key)
    : []
  return { name, labels }
}

function buildMetric(name, labels) {
  const valid = labels.filter(l => (l.key || '').trim())
  return valid.length
    ? `${name}{${valid.map(l => `${l.key}="${l.value}"`).join(',')}}`
    : name
}

function MetricsInput({ value, onChange }) {
  const parsed = parseMetric(value)
  const [internalName, setInternalName] = useState(parsed.name)
  const [internalLabels, setInternalLabels] = useState(parsed.labels)
  const lastCommit = useRef(value)

  useEffect(() => {
    if (value !== lastCommit.current) {
      const p = parseMetric(value)
      setInternalName(p.name)
      setInternalLabels(p.labels)
      lastCommit.current = value
    }
  }, [value])

  function commit(n, lbls) {
    const newValue = buildMetric(n, lbls)
    lastCommit.current = newValue
    onChange(newValue)
  }

  return (
    <div>
      <input type="text" value={internalName} placeholder="metric_name"
        style={{ marginBottom: 4 }}
        onChange={e => { setInternalName(e.target.value); commit(e.target.value, internalLabels) }} />
      <KVEditor
        rows={internalLabels}
        onChange={rows => { setInternalLabels(rows); commit(internalName, rows) }}
        keyPlaceholder="label" valuePlaceholder="value"
      />
    </div>
  )
}

// ── Type-aware var value input ────────────────────────────────────────────────

function VarInput({ type, value, onChange }) {
  if (type === 'op') {
    return (
      <select value={value} onChange={e => onChange(e.target.value)} style={{ width: '100%' }}>
        <option value="">— select —</option>
        {OP_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  }
  if (type === 'func') {
    return (
      <select value={value} onChange={e => onChange(e.target.value)} style={{ width: '100%' }}>
        <option value="">— select —</option>
        {FUNC_OPTIONS.map(f => <option key={f} value={f}>{f}</option>)}
      </select>
    )
  }
  if (type === 'int') {
    return (
      <input type="number" value={value} onChange={e => onChange(e.target.value)}
        style={{ width: '100%' }} />
    )
  }
  if (type === 'metrics') {
    return <MetricsInput value={value} onChange={onChange} />
  }
  // string, time, default: auto-expanding textarea
  return (
    <textarea value={value} placeholder={type === 'time' ? 'e.g. 5m' : 'fill value'}
      rows={1}
      style={{ resize: 'none', overflowY: 'hidden', width: '100%', minHeight: 'unset', fontFamily: 'inherit' }}
      onInput={e => { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px' }}
      onChange={e => onChange(e.target.value)} />
  )
}

// ── State factories ───────────────────────────────────────────────────────────

const emptyRule = () => ({
  alertTypeName: '',
  alertTypeVersion: '',
  ruleName: '',
  vars: [],        // [{ key, value, type }]
  for: '',
  description: '',
  labels: [],
  severity: 'warning',
})

const emptyInhibit = () => ({ sourceRule: '', targetRule: '' })

const emptyForm = () => ({
  groupName: '',
  groupLabel: '',
  rules: [],
  inhibit: [],
})

export default function AlertSuiteEditor() {
  const [templates, setTemplates]   = useState({})
  const [alertTypes, setAlertTypes] = useState({})
  const [selected, setSelected]     = useState(null)
  const [form, setForm]             = useState(emptyForm())
  const [isNew, setIsNew]           = useState(false)
  const [modal, setModal]           = useState(null)
  const [status, setStatus]         = useState('')

  // Cache of alert type var declarations: { "name@version": [{name, description, type}] }
  const [varDeclCache, setVarDeclCache] = useState({})

  const load = useCallback(async () => {
    const [suites, at] = await Promise.all([listTemplates(TYPE), listTemplates('alert-type')])
    setTemplates(suites)
    setAlertTypes(at)
  }, [])
  useEffect(() => { load() }, [load])

  async function loadVarDecls(atName, atVersion) {
    if (!atName || !atVersion) return []
    const cacheKey = `${atName}@${atVersion}`
    if (varDeclCache[cacheKey]) return varDeclCache[cacheKey]
    const data = await getTemplate('alert-type', atName, atVersion)
    const decls = data?.parsed?.vars || []
    setVarDeclCache(c => ({ ...c, [cacheKey]: decls }))
    return decls
  }

  async function selectVersion(name, version) {
    const data = await getTemplate(TYPE, name, version)
    if (!data) return
    const s = data.parsed?.alertSuite || {}

    const rules = await Promise.all((s.rules || []).map(async r => {
      const decls = await loadVarDecls(r.alertTypeName, r.alertTypeVersion)
      const savedVars = r.vars || {}
      const vars = decls.length
        ? decls.map(d => ({ key: d.name, value: String(savedVars[d.name] ?? ''), type: d.type || 'string' }))
        : objectToKvArray(savedVars).map(v => ({ ...v, type: 'string' }))
      return {
        alertTypeName:    r.alertTypeName    || '',
        alertTypeVersion: r.alertTypeVersion || '',
        ruleName:         r.ruleName         || '',
        vars,
        for:         r.for         || '',
        description: r.description || '',
        labels:      objectToKvArray(r.labels || {}),
        severity:    r.severity    || 'warning',
      }
    }))

    setForm({
      groupName:  s.name       || name,
      groupLabel: s.groupLabel || '',
      rules,
      inhibit: (s.inhibit || []).map(i => ({ sourceRule: i.sourceRule || '', targetRule: i.targetRule || '' })),
    })
    setSelected({ name, version })
    setIsNew(false)
  }

  function startNew() {
    setForm(emptyForm())
    setSelected(null)
    setIsNew(true)
  }

  async function handleRuleTypeChange(i, field, val) {
    setForm(f => ({ ...f, rules: f.rules.map((r, idx) => idx === i ? { ...r, [field]: val } : r) }))
    const rule = { ...form.rules[i], [field]: val }
    if (rule.alertTypeName && rule.alertTypeVersion) {
      const decls = await loadVarDecls(rule.alertTypeName, rule.alertTypeVersion)
      setForm(f => ({
        ...f,
        rules: f.rules.map((r, idx) => {
          if (idx !== i) return r
          const existing = kvArrayToObject(r.vars)
          const vars = decls.map(d => ({
            key:   d.name,
            value: String(existing[d.name] ?? ''),
            type:  d.type || 'string',
          }))
          return { ...r, [field]: val, vars }
        })
      }))
    }
  }

  function updateRule(i, field, val) {
    setForm(f => ({ ...f, rules: f.rules.map((r, idx) => idx === i ? { ...r, [field]: val } : r) }))
  }
  function addRule()    { setForm(f => ({ ...f, rules: [...f.rules, emptyRule()] })) }
  function removeRule(i){ setForm(f => ({ ...f, rules: f.rules.filter((_, idx) => idx !== i) })) }

  function updateInhibit(i, field, val) {
    setForm(f => ({ ...f, inhibit: f.inhibit.map((r, idx) => idx === i ? { ...r, [field]: val } : r) }))
  }
  function addInhibit()    { setForm(f => ({ ...f, inhibit: [...f.inhibit, emptyInhibit()] })) }
  function removeInhibit(i){ setForm(f => ({ ...f, inhibit: f.inhibit.filter((_, idx) => idx !== i) })) }

  const ruleNames = form.rules.map(r => r.ruleName).filter(Boolean)

  function buildPayload() {
    return {
      alertSuite: {
        name:       form.groupName,
        groupLabel: form.groupLabel,
        rules: form.rules.map(r => {
          const obj = {
            alertTypeName:    r.alertTypeName,
            alertTypeVersion: r.alertTypeVersion,
            ruleName:         r.ruleName,
            vars:             kvArrayToObject(r.vars),
            severity:         r.severity,
          }
          if (r.for)         obj.for = r.for
          if (r.description) obj.description = r.description
          const labels = kvArrayToObject(r.labels)
          if (Object.keys(labels).length) obj.labels = labels
          return obj
        }),
        ...(form.inhibit.length > 0 && { inhibit: form.inhibit }),
      }
    }
  }

  async function handleSave(version) {
    setModal(null)
    const name = selected?.name || form.groupName || `group-${Date.now()}`
    await saveTemplate(TYPE, name, version, buildPayload())
    await load()
    setSelected({ name, version })
    setIsNew(false)
    setStatus(`Saved @ ${version}`)
    setTimeout(() => setStatus(''), 2500)
  }

  function openSaveModal() {
    const n = selected?.name || form.groupName
    const v = selected
      ? bumpPatch(selected.version)
      : (n && templates[n] ? bumpPatch(latestVersion(templates[n])) : 'v1.0.0')
    setModal(v)
  }

  async function handleDelete() {
    if (!selected || !confirm(`Delete ${selected.name} @ ${selected.version}?`)) return
    await deleteTemplate(TYPE, selected.name, selected.version)
    setSelected(null); setForm(emptyForm()); setIsNew(false)
    await load()
  }

  return (
    <div className="editor-layout">
      <div className="editor-list">
        <div className="editor-list-header">
          Alert Groups
          <button className="btn btn-primary btn-sm" onClick={startNew}>+ New</button>
        </div>
        <div className="editor-list-body">
          {Object.keys(templates).length === 0 && (
            <div style={{ padding: '20px 14px', color: '#9ca3af', fontSize: 13 }}>No groups yet.</div>
          )}
          {Object.entries(templates).map(([name, versions]) => (
            <div key={name} className="template-group">
              <div className="template-group-name">{name}</div>
              {versions.map(v => (
                <div key={v}
                  className={`template-version${selected?.name === name && selected?.version === v ? ' active' : ''}`}
                  onClick={() => selectVersion(name, v)}
                >
                  <span className="version-badge">{v}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="editor-form">
        {!isNew && !selected ? (
          <div className="empty-state">
            <div className="empty-state-icon">📦</div>
            <p>Select an alert group or click + New.</p>
          </div>
        ) : (
          <>
            <div className="form-card">
              <div className="form-card-title">
                {selected ? `${selected.name} @ ${selected.version}` : 'New Alert Group'}
                {status && <span className="tag">{status}</span>}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="form-row">
                  <label>Group Name *</label>
                  <input type="text" value={form.groupName} placeholder="e.g. platform-group"
                    onChange={e => setForm(f => ({ ...f, groupName: e.target.value }))} />
                </div>
                <div className="form-row">
                  <label>Group Label</label>
                  <input type="text" value={form.groupLabel} placeholder="e.g. team: platform"
                    onChange={e => setForm(f => ({ ...f, groupLabel: e.target.value }))} />
                </div>
              </div>
            </div>

            <div className="form-card">
              <div className="form-card-title">
                Rules
                <button className="btn btn-secondary btn-sm" onClick={addRule}>+ Add Rule</button>
              </div>
              {form.rules.length === 0 && <p className="text-muted">No rules yet.</p>}
              {form.rules.map((rule, i) => {
                const versionsForType = rule.alertTypeName ? (alertTypes[rule.alertTypeName] || []) : []
                return (
                  <div key={i} style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: 14, marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>
                        Rule {i + 1}{rule.ruleName ? `: ${rule.ruleName}` : ''}
                      </span>
                      <button className="btn btn-danger btn-sm" onClick={() => removeRule(i)}>Remove</button>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
                      <div className="form-row">
                        <label>Alert Type *</label>
                        <select value={rule.alertTypeName}
                          onChange={e => handleRuleTypeChange(i, 'alertTypeName', e.target.value)}>
                          <option value="">— select —</option>
                          {Object.keys(alertTypes).map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                      </div>
                      <div className="form-row">
                        <label>Version *</label>
                        <select value={rule.alertTypeVersion}
                          onChange={e => handleRuleTypeChange(i, 'alertTypeVersion', e.target.value)}>
                          <option value="">— select —</option>
                          {versionsForType.map(v => <option key={v} value={v}>{v}</option>)}
                        </select>
                      </div>
                      <div className="form-row">
                        <label>Rule Name *</label>
                        <input type="text" value={rule.ruleName} placeholder="e.g. high-cpu"
                          onChange={e => updateRule(i, 'ruleName', e.target.value)} />
                      </div>
                    </div>

                    {rule.vars.length > 0 && (
                      <div className="form-row">
                        <label>Var Values</label>
                        <table className="kv-table" style={{ width: '100%', tableLayout: 'fixed' }}>
                          <colgroup>
                            <col style={{ width: '30%' }} />
                            <col style={{ width: '15%' }} />
                            <col />
                          </colgroup>
                          <thead>
                            <tr><th>var name</th><th>type</th><th>value</th></tr>
                          </thead>
                          <tbody>
                            {rule.vars.map((v, vi) => (
                              <tr key={vi}>
                                <td>
                                  <input type="text" value={v.key} readOnly
                                    style={{ background: '#f9fafb', color: '#6b7280' }} />
                                </td>
                                <td>
                                  <span style={{
                                    fontSize: 11, background: '#e0e7ff', color: '#4338ca',
                                    padding: '2px 6px', borderRadius: 4, display: 'inline-block'
                                  }}>
                                    {v.type || 'string'}
                                  </span>
                                </td>
                                <td>
                                  <VarInput
                                    type={v.type || 'string'}
                                    value={v.value}
                                    onChange={val => {
                                      const vars = rule.vars.map((vv, vvi) =>
                                        vvi === vi ? { ...vv, value: val } : vv)
                                      updateRule(i, 'vars', vars)
                                    }}
                                  />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {rule.vars.length === 0 && rule.alertTypeName && rule.alertTypeVersion && (
                      <p className="text-muted">This alert type declares no vars.</p>
                    )}
                    {rule.vars.length === 0 && (!rule.alertTypeName || !rule.alertTypeVersion) && (
                      <p className="text-muted">Select alert type + version to auto-generate var fields.</p>
                    )}

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginTop: 10 }}>
                      <div className="form-row">
                        <label>Severity</label>
                        <select value={rule.severity} onChange={e => updateRule(i, 'severity', e.target.value)}>
                          {SEVERITIES.map(s => <option key={s}>{s}</option>)}
                        </select>
                      </div>
                      <div className="form-row">
                        <label>For (override)</label>
                        <input type="text" value={rule.for} placeholder="e.g. 10m"
                          onChange={e => updateRule(i, 'for', e.target.value)} />
                      </div>
                      <div className="form-row">
                        <label>Description</label>
                        <input type="text" value={rule.description} placeholder="Optional"
                          onChange={e => updateRule(i, 'description', e.target.value)} />
                      </div>
                    </div>

                    <div className="form-row" style={{ marginTop: 8 }}>
                      <label>Labels</label>
                      <KVEditor rows={rule.labels}
                        onChange={rows => updateRule(i, 'labels', rows)}
                        keyPlaceholder="label key" valuePlaceholder="value" />
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="form-card">
              <div className="form-card-title">
                Inhibit Rules
                <button className="btn btn-secondary btn-sm" onClick={addInhibit}>+ Add</button>
              </div>
              <p className="text-muted" style={{ marginBottom: 8 }}>
                Source rule suppresses target rule.
              </p>
              {form.inhibit.length === 0 && <p className="text-muted">No inhibit rules.</p>}
              {form.inhibit.map((inh, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'flex-end' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 3 }}>Source Rule</div>
                    <select value={inh.sourceRule} onChange={e => updateInhibit(i, 'sourceRule', e.target.value)}>
                      <option value="">— select —</option>
                      {ruleNames.map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                  <div style={{ paddingBottom: 8, color: '#9ca3af' }}>→ suppresses →</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 3 }}>Target Rule</div>
                    <select value={inh.targetRule} onChange={e => updateInhibit(i, 'targetRule', e.target.value)}>
                      <option value="">— select —</option>
                      {ruleNames.map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                  <button className="btn btn-ghost btn-icon" style={{ marginBottom: 2 }}
                    onClick={() => removeInhibit(i)}>×</button>
                </div>
              ))}
            </div>

            <div className="btn-row">
              <button className="btn btn-primary" onClick={openSaveModal}>Save as Version…</button>
              {selected && (
                <button className="btn btn-danger" onClick={handleDelete}>Delete this version</button>
              )}
            </div>
          </>
        )}
      </div>

      {modal && (
        <VersionModal defaultVersion={modal} onSave={handleSave} onCancel={() => setModal(null)} />
      )}
    </div>
  )
}
