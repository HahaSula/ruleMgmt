import { useState, useEffect, useCallback } from 'react'
import VersionModal from '../components/VersionModal'
import { listTemplates, getTemplate, saveTemplate, deleteTemplate } from '../utils/api'
import { bumpPatch } from '../utils/templateUtils'

const TYPE = 'system'
const SEVERITIES = ['critical', 'warning', 'info', 'none']

const emptyRoute  = () => ({ severity: 'critical', receiver: '' })
const emptyForm   = () => ({
  templateName:      '',   // folder name shown in list
  systemName:        '',   // metadata.name in AlertmanagerConfig (system.name in values.yaml)
  alertSuiteName:    '',   // which alert group to reference
  alertSuiteVersion: '',
  groupLabel:        '',
  routes:            [],
})

export default function SystemEditor() {
  const [templates, setTemplates] = useState({})
  const [suites, setSuites]       = useState({})
  const [receivers, setReceivers] = useState({})
  const [selected, setSelected]   = useState(null)
  const [form, setForm]           = useState(emptyForm())
  const [isNew, setIsNew]         = useState(false)
  const [modal, setModal]         = useState(null)
  const [status, setStatus]       = useState('')

  const load = useCallback(async () => {
    const [sys, s, r] = await Promise.all([
      listTemplates(TYPE),
      listTemplates('alert-suite'),
      listTemplates('receivers'),
    ])
    setTemplates(sys)
    setSuites(s)
    setReceivers(r)
  }, [])
  useEffect(() => { load() }, [load])

  async function selectVersion(name, version) {
    const data = await getTemplate(TYPE, name, version)
    if (!data) return
    const s = data.parsed?.system || {}
    setForm({
      templateName:      name,
      systemName:        s.name              || '',
      alertSuiteName:    s.alertSuite        || '',
      alertSuiteVersion: s.alertSuiteVersion || '',
      groupLabel:        s.groupLabel        || '',
      routes: (s.routes || []).map(r => ({ severity: r.severity || 'critical', receiver: r.receiver || '' })),
    })
    setSelected({ name, version })
    setIsNew(false)
  }

  function startNew() {
    setForm(emptyForm())
    setSelected(null)
    setIsNew(true)
  }

  const suiteVersions = form.alertSuiteName ? (suites[form.alertSuiteName] || []) : []
  const receiverNames = Object.keys(receivers)

  function updateRoute(i, field, val) {
    setForm(f => ({ ...f, routes: f.routes.map((r, idx) => idx === i ? { ...r, [field]: val } : r) }))
  }
  function addRoute()     { setForm(f => ({ ...f, routes: [...f.routes, emptyRoute()] })) }
  function removeRoute(i) { setForm(f => ({ ...f, routes: f.routes.filter((_, idx) => idx !== i) })) }

  function buildPayload() {
    return {
      system: {
        name:              form.systemName,
        alertSuite:        form.alertSuiteName,
        alertSuiteVersion: form.alertSuiteVersion || 'latest',
        groupLabel:        form.groupLabel,
        routes:            form.routes.map(r => ({ severity: r.severity, receiver: r.receiver })),
      }
    }
  }

  async function handleSave(version) {
    setModal(null)
    const name = form.templateName.trim() || selected?.name || `system-${Date.now()}`
    await saveTemplate(TYPE, name, version, buildPayload())
    await load()
    setSelected({ name, version })
    setIsNew(false)
    setStatus(`Saved @ ${version}`)
    setTimeout(() => setStatus(''), 2500)
  }

  function openSaveModal() {
    setModal(selected ? bumpPatch(selected.version) : 'v1.0.0')
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
          System
          <button className="btn btn-primary btn-sm" onClick={startNew}>+ New</button>
        </div>
        <div className="editor-list-body">
          {Object.keys(templates).length === 0 && (
            <div style={{ padding: '20px 14px', color: '#9ca3af', fontSize: 13 }}>No system templates yet.</div>
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

      <div className="editor-form">
        {!isNew && !selected ? (
          <div className="empty-state">
            <div className="empty-state-icon">🔧</div>
            <p>Select a system template or click + New.</p>
          </div>
        ) : (
          <>
            <div className="form-card">
              <div className="form-card-title">
                {selected ? `${selected.name} @ ${selected.version}` : 'New System'}
                {status && <span className="tag">{status}</span>}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="form-row">
                  <label>Template Name *</label>
                  <input type="text" value={form.templateName}
                    placeholder="e.g. mysql-system"
                    readOnly={!isNew && !!selected}
                    style={!isNew && selected ? { background: '#f9fafb', color: '#6b7280' } : {}}
                    onChange={e => setForm(f => ({ ...f, templateName: e.target.value }))} />
                </div>
                <div className="form-row">
                  <label>Config Name</label>
                  <input type="text" value={form.systemName}
                    placeholder="name in AlertmanagerConfig metadata"
                    onChange={e => setForm(f => ({ ...f, systemName: e.target.value }))} />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 4 }}>
                <div className="form-row">
                  <label>Alert Group</label>
                  <select value={form.alertSuiteName}
                    onChange={e => setForm(f => ({ ...f, alertSuiteName: e.target.value, alertSuiteVersion: '' }))}>
                    <option value="">— select alert group —</option>
                    {Object.keys(suites).map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <div className="form-row">
                  <label>Group Version</label>
                  <select value={form.alertSuiteVersion}
                    onChange={e => setForm(f => ({ ...f, alertSuiteVersion: e.target.value }))}>
                    <option value="">— latest —</option>
                    {suiteVersions.map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
              </div>

              <div className="form-row">
                <label>Group Label</label>
                <input type="text" value={form.groupLabel} placeholder="e.g. team: platform"
                  onChange={e => setForm(f => ({ ...f, groupLabel: e.target.value }))} />
              </div>
            </div>

            <div className="form-card">
              <div className="form-card-title">
                Severity → Receiver Routes
                <button className="btn btn-secondary btn-sm" onClick={addRoute}>+ Add Route</button>
              </div>
              <p className="text-muted" style={{ marginBottom: 10 }}>
                Maps severity labels to receiver names. Names will get product prefix when rendered.
              </p>
              {form.routes.length === 0 && <p className="text-muted">No routes configured yet.</p>}

              <table className="kv-table" style={{ width: '100%' }}>
                <thead>
                  <tr><th>Severity</th><th>Receiver Name</th><th></th></tr>
                </thead>
                <tbody>
                  {form.routes.map((route, i) => (
                    <tr key={i}>
                      <td>
                        <select value={route.severity} onChange={e => updateRoute(i, 'severity', e.target.value)}>
                          {SEVERITIES.map(s => <option key={s}>{s}</option>)}
                        </select>
                      </td>
                      <td>
                        <input
                          type="text"
                          list={`receiver-list-${i}`}
                          value={route.receiver}
                          placeholder="receiver name"
                          onChange={e => updateRoute(i, 'receiver', e.target.value)}
                        />
                        <datalist id={`receiver-list-${i}`}>
                          {receiverNames.map(n => <option key={n} value={n} />)}
                        </datalist>
                      </td>
                      <td>
                        <button className="btn btn-ghost btn-icon" onClick={() => removeRoute(i)}>×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="btn-row">
              <button className="btn btn-primary" onClick={openSaveModal}>Save as Version…</button>
              {selected && <button className="btn btn-danger" onClick={handleDelete}>Delete this version</button>}
            </div>
          </>
        )}
      </div>

      {modal && <VersionModal defaultVersion={modal} onSave={handleSave} onCancel={() => setModal(null)} />}
    </div>
  )
}
