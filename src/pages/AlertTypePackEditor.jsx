import { useState, useEffect, useCallback, useMemo } from 'react'
import KVEditor from '../components/KVEditor'
import VersionModal from '../components/VersionModal'
import { listTemplates, getTemplate, saveTemplate, deleteTemplate } from '../utils/api'
import { kvArrayToObject, bumpPatch, latestVersion } from '../utils/templateUtils'

const TYPE = 'alert-type-pack'
const VAR_TYPES = ['string', 'metrics', 'op', 'func', 'time', 'int']

let _uid = 0
const uid = () => String(++_uid)

const emptyPackRule = () => ({
  _id: uid(),
  ruleName: '',
  expr: '',
  labels: [{ key: 'severity', value: 'warning' }],
  for: '',
  description: '',
})

const emptyForm = () => ({
  name: '',
  description: '',
  vars: [],
  rules: [emptyPackRule()],
})

// ── YAML preview builder ──────────────────────────────────────────────────────

function buildPackPreview(form) {
  let y = ''
  y += `name: ${form.name || 'unnamed-pack'}\n`
  if (form.description) y += `description: ${JSON.stringify(form.description)}\n`

  const vars = form.vars.filter(v => v.name.trim())
  if (vars.length) {
    y += `vars:\n`
    for (const v of vars) {
      y += `  - name: ${v.name}\n`
      if (v.type && v.type !== 'string') y += `    type: ${v.type}\n`
      if (v.description) y += `    description: ${JSON.stringify(v.description)}\n`
    }
  }

  const rules = form.rules.filter(r => r.ruleName.trim() || r.expr.trim())
  y += `rules:\n`
  if (!rules.length) {
    y += `  []\n`
  } else {
    for (const r of rules) {
      y += `  - ruleName: ${JSON.stringify(r.ruleName || '')}\n`
      y += `    expr: ${JSON.stringify(r.expr || '')}\n`
      const lbls = (r.labels || []).filter(l => l.key.trim())
      if (lbls.length) {
        y += `    labels:\n`
        for (const { key, value } of lbls) y += `      ${key}: ${value}\n`
      }
      if (r.for) y += `    for: ${r.for}\n`
      if (r.description) y += `    description: ${JSON.stringify(r.description)}\n`
    }
  }
  return y.trimEnd()
}

// ── Fill template preview: replace {{ .varName }} with <varName> ──────────────

function previewFill(str, vars) {
  if (!str) return ''
  const map = {}
  for (const v of vars) if (v.name.trim()) map[v.name.trim()] = `<${v.name.trim()}>`
  map['alertName'] = '<alertName>'
  return str.replace(/\{\{\s*\.(\w+)\s*\}\}/g, (_, k) => map[k] ?? `{{ .${k} }}`)
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AlertTypePackEditor() {
  const [templates, setTemplates] = useState({})
  const [selected, setSelected]   = useState(null)
  const [form, setForm]           = useState(emptyForm())
  const [isNew, setIsNew]         = useState(false)
  const [modal, setModal]         = useState(null)
  const [status, setStatus]       = useState('')
  const [showPreview, setShowPreview] = useState(false)

  const load = useCallback(async () => {
    const ts = await listTemplates(TYPE)
    setTemplates(ts)
  }, [])
  useEffect(() => { load() }, [load])

  async function selectVersion(name, version) {
    const data = await getTemplate(TYPE, name, version)
    if (!data) return
    const p = data.parsed || {}
    setForm({
      name:        p.name        || name,
      description: p.description || '',
      vars: (p.vars || []).map(v => ({
        name:        v.name        || '',
        type:        v.type        || 'string',
        description: v.description || '',
      })),
      rules: (p.rules || [emptyPackRule()]).map(r => ({
        _id:         uid(),
        ruleName:    r.ruleName    || '',
        expr:        r.expr        || '',
        labels: r.labels
          ? Object.entries(r.labels).map(([key, value]) => ({ key, value: String(value) }))
          : (r.severity ? [{ key: 'severity', value: r.severity }] : [{ key: 'severity', value: 'warning' }]),
        for:         r.for         || '',
        description: r.description || '',
      })),
    })
    setSelected({ name, version })
    setIsNew(false)
  }

  function startNew() {
    setForm(emptyForm())
    setSelected(null)
    setIsNew(true)
  }

  // ── Var CRUD ───────────────────────────────────────────────────────────────

  function addVar() {
    setForm(f => ({ ...f, vars: [...f.vars, { name: '', type: 'string', description: '' }] }))
  }
  function removeVar(i) {
    setForm(f => ({ ...f, vars: f.vars.filter((_, idx) => idx !== i) }))
  }
  function updateVar(i, field, val) {
    setForm(f => ({ ...f, vars: f.vars.map((v, idx) => idx === i ? { ...v, [field]: val } : v) }))
  }

  // ── Rule template CRUD ─────────────────────────────────────────────────────

  function addPackRule() {
    setForm(f => ({ ...f, rules: [...f.rules, emptyPackRule()] }))
  }
  function removePackRule(id) {
    setForm(f => ({ ...f, rules: f.rules.filter(r => r._id !== id) }))
  }
  function updatePackRule(id, field, val) {
    setForm(f => ({ ...f, rules: f.rules.map(r => r._id === id ? { ...r, [field]: val } : r) }))
  }

  // ── Save / Delete ──────────────────────────────────────────────────────────

  function buildPayload() {
    return {
      name:        form.name,
      description: form.description || undefined,
      vars: form.vars.filter(v => v.name.trim()).map(v => ({
        name: v.name.trim(),
        type: v.type || 'string',
        ...(v.description ? { description: v.description } : {}),
      })),
      rules: form.rules.map(r => {
        const obj = {
          ruleName: r.ruleName,
          expr:     r.expr,
        }
        const lbls = kvArrayToObject((r.labels || []).filter(l => l.key.trim()))
        if (Object.keys(lbls).length) obj.labels = lbls
        if (r.for)         obj.for = r.for
        if (r.description) obj.description = r.description
        return obj
      }),
    }
  }

  async function handleSave(name, version) {
    setModal(null)
    if (!name) return
    await saveTemplate(TYPE, name, version, buildPayload())
    await load()
    setSelected({ name, version })
    setIsNew(false)
    setStatus(`Saved ${name} @ ${version}`)
    setTimeout(() => setStatus(''), 2500)
  }

  function openSaveModal() {
    const n = form.name.trim()
    const existing = templates[n]
    const suggested = selected
      ? bumpPatch(selected.version)
      : (existing?.length ? bumpPatch(latestVersion(existing)) : 'v1.0.0')
    setModal({ name: n, version: suggested })
  }

  async function handleDelete() {
    if (!selected || !confirm(`Delete ${selected.name} @ ${selected.version}?`)) return
    await deleteTemplate(TYPE, selected.name, selected.version)
    setSelected(null); setForm(emptyForm()); setIsNew(false)
    await load()
  }

  const preview = useMemo(() => buildPackPreview(form), [form])

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="editor-layout">

      {/* Sidebar */}
      <div className="editor-list">
        <div className="editor-list-header">
          Alert Packs
          <button className="btn btn-primary btn-sm" onClick={startNew}>+ New</button>
        </div>
        <div className="editor-list-body">
          {Object.keys(templates).length === 0 && (
            <div style={{ padding: '20px 14px', color: '#9ca3af', fontSize: 13 }}>No packs yet.</div>
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

      {/* Form */}
      <div className="editor-form" style={showPreview && (isNew || selected) ? { display: 'flex', gap: 0, padding: 0, overflow: 'hidden' } : {}}>
        {!isNew && !selected ? (
          <div className="empty-state">
            <div className="empty-state-icon">📋</div>
            <p>Select a pack or click + New to create one.</p>
          </div>
        ) : (
          <div style={showPreview ? { display: 'flex', width: '100%', height: '100%', overflow: 'hidden' } : {}}>
          <div style={showPreview ? { flex: 1, overflowY: 'auto', padding: 24, minWidth: 0 } : {}}>

            {/* Identity */}
            <div className="form-card">
              <div className="form-card-title">
                <span>
                  {isNew ? 'New Alert Pack' : `${selected.name} @ ${selected.version}`}
                  {status && <span className="tag">{status}</span>}
                </span>
                <button
                  className={`btn btn-sm ${showPreview ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setShowPreview(v => !v)}
                >
                  {showPreview ? 'Hide Preview' : 'Show Preview'}
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="form-row" style={{ marginBottom: 0 }}>
                  <label>Name *</label>
                  <input type="text" value={form.name} placeholder="e.g. threshold-pair"
                    readOnly={!isNew && !!selected}
                    style={!isNew && selected ? { background: '#f9fafb', color: '#6b7280' } : {}}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                </div>
                <div className="form-row" style={{ marginBottom: 0 }}>
                  <label>Description</label>
                  <input type="text" value={form.description} placeholder="Optional"
                    onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
                </div>
              </div>
            </div>

            {/* Shared Variables */}
            <div className="form-card">
              <div className="form-card-title">
                Shared Variables
                <button className="btn btn-secondary btn-sm" onClick={addVar}>+ Add Var</button>
              </div>
              <p className="text-muted" style={{ marginBottom: 10 }}>
                Variables declared here are shared across all rule templates in this pack.
                Use <code style={{ fontFamily: 'monospace', background: '#f1f5f9', padding: '1px 5px', borderRadius: 3 }}>{'{{ .varName }}'}</code> in rule expressions, names, and descriptions.
                The special variable <code style={{ fontFamily: 'monospace', background: '#ede9fe', color: '#6d28d9', padding: '1px 5px', borderRadius: 3 }}>{'{{ .alertName }}'}</code> is
                set by the instance's alert name prefix.
              </p>
              {form.vars.length === 0 && <p className="text-muted">No shared vars declared.</p>}
              <table className="kv-table" style={{ width: '100%', tableLayout: 'fixed' }}>
                <colgroup>
                  <col style={{ width: '28%' }} />
                  <col style={{ width: '16%' }} />
                  <col />
                  <col style={{ width: 32 }} />
                </colgroup>
                <thead>
                  <tr><th>name</th><th>type</th><th>description</th><th></th></tr>
                </thead>
                <tbody>
                  {form.vars.map((v, i) => (
                    <tr key={i}>
                      <td><input type="text" value={v.name} placeholder="varName"
                        onChange={e => updateVar(i, 'name', e.target.value)} /></td>
                      <td>
                        <select value={v.type} onChange={e => updateVar(i, 'type', e.target.value)}>
                          {VAR_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </td>
                      <td><input type="text" value={v.description} placeholder="what this var means"
                        onChange={e => updateVar(i, 'description', e.target.value)} /></td>
                      <td><button className="btn btn-ghost btn-icon" onClick={() => removeVar(i)}>×</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Rule Templates */}
            <div className="form-card">
              <div className="form-card-title">
                Rule Templates
                <button className="btn btn-secondary btn-sm" onClick={addPackRule}>+ Add Rule Template</button>
              </div>
              <p className="text-muted" style={{ marginBottom: 12 }}>
                Each rule template is instantiated once per pack instance, with shared variable values substituted in.
              </p>
              {form.rules.map((rule, i) => {
                const exprPreview = previewFill(rule.expr, form.vars)
                const namePreview = previewFill(rule.ruleName, form.vars)
                return (
                  <div key={rule._id} style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: 14, marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                      <span style={{ fontWeight: 600, fontSize: 13, color: '#6366f1' }}>
                        Rule template {i + 1}
                        {namePreview && (
                          <span style={{ marginLeft: 8, fontWeight: 400, fontSize: 12, color: '#6b7280', fontFamily: 'monospace' }}>
                            → {namePreview}
                          </span>
                        )}
                      </span>
                      {form.rules.length > 1 && (
                        <button className="btn btn-danger btn-sm" onClick={() => removePackRule(rule._id)}>Remove</button>
                      )}
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                      <div className="form-row" style={{ marginBottom: 0 }}>
                        <label>Rule Name Template *</label>
                        <input type="text" value={rule.ruleName}
                          placeholder={'{{ .alertName }}-warning'}
                          onChange={e => updatePackRule(rule._id, 'ruleName', e.target.value)} />
                      </div>
                      <div className="form-row" style={{ marginBottom: 0 }}>
                        <label>For (duration)</label>
                        <input type="text" value={rule.for} placeholder="e.g. 5m"
                          onChange={e => updatePackRule(rule._id, 'for', e.target.value)} />
                      </div>
                    </div>

                    <div className="form-row" style={{ marginBottom: 10 }}>
                      <label>
                        Labels
                        <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400, marginLeft: 6 }}>
                          include <code style={{ fontFamily: 'monospace', background: '#f1f5f9', padding: '0 3px', borderRadius: 2 }}>severity</code> here · values can use {'{{ .varName }}'}
                        </span>
                      </label>
                      <KVEditor
                        rows={rule.labels}
                        onChange={rows => updatePackRule(rule._id, 'labels', rows)}
                        keyPlaceholder="label key"
                        valuePlaceholder="value or {{ .varName }}"
                      />
                    </div>

                    <div className="form-row" style={{ marginBottom: 8 }}>
                      <label>Expression Template (PromQL)</label>
                      <textarea rows={2} value={rule.expr}
                        placeholder={'{{ .metric }} > {{ .threshold }}'}
                        onChange={e => updatePackRule(rule._id, 'expr', e.target.value)} />
                      {rule.expr && (
                        <div className="preview-box" style={{ marginTop: 5, fontSize: 11.5 }}>
                          {exprPreview}
                        </div>
                      )}
                    </div>

                    <div className="form-row" style={{ marginBottom: 0 }}>
                      <label>Description Template</label>
                      <input type="text" value={rule.description}
                        placeholder={'{{ .metric }} exceeded threshold on {{ $labels.instance }}'}
                        onChange={e => updatePackRule(rule._id, 'description', e.target.value)} />
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="btn-row">
              <button className="btn btn-primary" onClick={openSaveModal}
                disabled={!form.name.trim() || form.rules.every(r => !r.expr.trim())}>
                Save as Version…
              </button>
              {selected && <button className="btn btn-danger" onClick={handleDelete}>Delete this version</button>}
            </div>
          </div>

          {/* YAML Preview pane */}
          {showPreview && (
            <div style={{
              width: 400, minWidth: 320, borderLeft: '1px solid #e5e7eb',
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
            }}>
              <div style={{
                padding: '10px 16px', borderBottom: '1px solid #e5e7eb',
                fontSize: 12, fontWeight: 600, color: '#6b7280',
              }}>
                YAML Preview
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
          )}
          </div>
        )}
      </div>

      {modal && <VersionModal defaultName={modal.name} defaultVersion={modal.version} onSave={handleSave} onCancel={() => setModal(null)} />}
    </div>
  )
}
