import { useState, useEffect, useCallback } from 'react'
import KVEditor from '../components/KVEditor'
import VersionModal from '../components/VersionModal'
import { listTemplates, getTemplate, saveTemplate, deleteTemplate } from '../utils/api'
import { kvArrayToObject, objectToKvArray, bumpPatch, latestVersion } from '../utils/templateUtils'

const TYPE = 'alert-type'
const VAR_TYPES = ['string', 'metrics', 'op', 'func', 'time', 'int']

// Render expr preview — substitutes {{ .varName }} and {{ .varName OP N }} with placeholders
function previewExpr(expr, varDecls) {
  if (!expr) return ''
  const map = {}
  for (const v of varDecls) {
    if (v.name.trim()) map[v.name.trim()] = `<${v.name.trim()}>`
  }
  let result = expr.replace(
    /\{\{\s*\.(\w+)\s*([+\-*/])\s*(\d+(?:\.\d+)?)\s*\}\}/g,
    (match, key, op, rhs) => map[key] ? `<${key}${op}${rhs}>` : match
  )
  result = result.replace(/\{\{\s*\.(\w+)\s*\}\}/g, (match, key) => map[key] ?? match)
  return result
}

const emptyForm = () => ({
  name: '',
  description: '',
  expr: '',
  vars: [],       // [{ name, description, type }]
  for: '',
  labels: [],     // [{ key, value }]
})

export default function AlertTypeEditor() {
  const [templates, setTemplates] = useState({})
  const [selected, setSelected]   = useState(null)
  const [form, setForm]           = useState(emptyForm())
  const [isNew, setIsNew]         = useState(false)
  const [modal, setModal]         = useState(null)
  const [status, setStatus]       = useState('')

  const load = useCallback(async () => {
    setTemplates(await listTemplates(TYPE))
  }, [])
  useEffect(() => { load() }, [load])

  async function selectVersion(name, version) {
    const data = await getTemplate(TYPE, name, version)
    if (!data) return
    const p = data.parsed || {}
    setForm({
      name:        p.name        || name,
      description: p.description || '',
      expr:        p.expr        || '',
      vars: (p.vars || []).map(v => ({
        name:        v.name        || '',
        description: v.description || '',
        type:        v.type        || 'string',
      })),
      for:    p.for    || '',
      labels: objectToKvArray(p.labels || {}),
    })
    setSelected({ name, version })
    setIsNew(false)
  }

  function startNew() {
    setForm(emptyForm())
    setSelected(null)
    setIsNew(true)
  }

  function buildPayload() {
    const out = {
      name: form.name,
      expr: form.expr,
      vars: form.vars
        .filter(v => v.name.trim())
        .map(v => ({
          name: v.name.trim(),
          type: v.type || 'string',
          ...(v.description && { description: v.description }),
        })),
    }
    if (form.description) out.description = form.description
    if (form.for) out.for = form.for
    const labels = kvArrayToObject(form.labels)
    if (Object.keys(labels).length) out.labels = labels
    return out
  }

  async function handleSave(version) {
    setModal(null)
    const name = form.name.trim()
    if (!name) return
    await saveTemplate(TYPE, name, version, buildPayload())
    await load()
    setSelected({ name, version })
    setIsNew(false)
    setStatus(`Saved ${name} @ ${version}`)
    setTimeout(() => setStatus(''), 2500)
  }

  function openSaveModal() {
    const existing = templates[form.name]
    const suggested = selected
      ? bumpPatch(selected.version)
      : (existing?.length ? bumpPatch(latestVersion(existing)) : 'v1.0.0')
    setModal(suggested)
  }

  async function handleDelete() {
    if (!selected || !confirm(`Delete ${selected.name} @ ${selected.version}?`)) return
    await deleteTemplate(TYPE, selected.name, selected.version)
    setSelected(null); setForm(emptyForm()); setIsNew(false)
    await load()
  }

  function addVar()          { setForm(f => ({ ...f, vars: [...f.vars, { name: '', description: '', type: 'string' }] })) }
  function removeVar(i)      { setForm(f => ({ ...f, vars: f.vars.filter((_, idx) => idx !== i) })) }
  function updateVar(i, field, val) {
    setForm(f => ({ ...f, vars: f.vars.map((v, idx) => idx === i ? { ...v, [field]: val } : v) }))
  }

  const preview = previewExpr(form.expr, form.vars)

  return (
    <div className="editor-layout">
      <div className="editor-list">
        <div className="editor-list-header">
          Alert Types
          <button className="btn btn-primary btn-sm" onClick={startNew}>+ New</button>
        </div>
        <div className="editor-list-body">
          {Object.keys(templates).length === 0 && (
            <div style={{ padding: '20px 14px', color: '#9ca3af', fontSize: 13 }}>No templates yet.</div>
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
            <div className="empty-state-icon">⚡</div>
            <p>Select a template or click + New to create one.</p>
          </div>
        ) : (
          <>
            <div className="form-card">
              <div className="form-card-title">
                {isNew ? 'New Alert Type' : `${selected.name} @ ${selected.version}`}
                {status && <span className="tag">{status}</span>}
              </div>

              <div className="form-row">
                <label>Name *</label>
                <input type="text" value={form.name} placeholder="e.g. single-threshold"
                  readOnly={!isNew && !!selected}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
              </div>

              <div className="form-row">
                <label>Description</label>
                <input type="text" value={form.description} placeholder="Optional description"
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
              </div>

              <div className="form-row">
                <label>Expr *</label>
                <textarea rows={2} value={form.expr}
                  placeholder={'{{ .func }}({{ .metrics }}[{{ .time }}]) {{ .op }} {{ .threshold }}'}
                  onChange={e => setForm(f => ({ ...f, expr: e.target.value }))} />
                <span className="text-muted">
                  {'Use {{ .varName }} for substitution, {{ .intVar + 10 }} for arithmetic.'}
                </span>
              </div>

              <div className="form-row">
                <label>For (duration, optional)</label>
                <input type="text" value={form.for} placeholder="e.g. 5m"
                  onChange={e => setForm(f => ({ ...f, for: e.target.value }))} />
              </div>
            </div>

            <div className="form-card">
              <div className="form-card-title">
                Var Declarations
                <button className="btn btn-secondary btn-sm" onClick={addVar}>+ Add Var</button>
              </div>
              <p className="text-muted" style={{ marginBottom: 10 }}>
                Declare parameters with types. Alert Group fills in actual values.
              </p>
              {form.vars.length === 0 && <p className="text-muted">No vars declared yet.</p>}
              <table className="kv-table" style={{ width: '100%', tableLayout: 'fixed' }}>
                <colgroup>
                  <col style={{ width: '28%' }} />
                  <col style={{ width: '18%' }} />
                  <col />
                  <col style={{ width: '32px' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>name</th>
                    <th>type</th>
                    <th>description</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {form.vars.map((v, i) => (
                    <tr key={i}>
                      <td>
                        <input type="text" value={v.name} placeholder="varName"
                          onChange={e => updateVar(i, 'name', e.target.value)} />
                      </td>
                      <td>
                        <select value={v.type} onChange={e => updateVar(i, 'type', e.target.value)}>
                          {VAR_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </td>
                      <td>
                        <input type="text" value={v.description} placeholder="what this var means"
                          onChange={e => updateVar(i, 'description', e.target.value)} />
                      </td>
                      <td>
                        <button className="btn btn-ghost btn-icon" onClick={() => removeVar(i)}>×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="form-card">
              <div className="form-card-title">Labels (optional)</div>
              <KVEditor rows={form.labels}
                onChange={rows => setForm(f => ({ ...f, labels: rows }))}
                keyPlaceholder="label key" valuePlaceholder="value" />
            </div>

            <div className="form-card">
              <div className="form-card-title">Expr Preview</div>
              <p className="text-muted" style={{ marginBottom: 8 }}>
                Var names shown as placeholders (actual values filled by Alert Group).
              </p>
              <div className="preview-box">
                {preview || <span style={{ color: '#475569' }}>Enter expr and declare vars above</span>}
              </div>
            </div>

            <div className="btn-row">
              <button className="btn btn-primary" onClick={openSaveModal}
                disabled={!form.name.trim() || !form.expr.trim()}>
                Save as Version…
              </button>
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
