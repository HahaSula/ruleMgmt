import { useState, useEffect, useCallback } from 'react'
import {
  getProduct, setProduct,
  listSites, createSite, deleteSite,
  listRelunits, createRelunit, deleteRelunit,
  getStage, saveStage, deleteStage,
  listTemplates, getSystemChartMeta, runHelmRender,
} from '../utils/api'
import KVEditor from '../components/KVEditor'
import { objectToKvArray, kvArrayToObject } from '../utils/templateUtils'

const STAGES = ['DEV', 'TEST', 'STG', 'PROD']

// Build the Chart.yaml object for a gitops stage
function buildStageChart(relunit, stage, chartName, chartVersion, systemName, systemVersion) {
  // chartVersion has 'v' prefix in folder name; strip it for the Helm semver field
  const semver = chartVersion.replace(/^v/, '')
  // 5 levels up from stage folder to repo root:
  // gitops-deploy / product / site / relunit / stage  →  ../../../../../
  const repoPath = `../../../../../templates/system/${systemName}/${systemVersion}`
  return {
    apiVersion: 'v2',
    name: `${relunit}-${stage}`.toLowerCase(),  // Helm release names must be lowercase
    description: `Gitops deploy chart for ${relunit}/${stage}`,
    type: 'application',
    version: '0.1.0',
    dependencies: [{
      name: chartName,
      version: semver,
      repository: `file://${repoPath}`,
    }],
  }
}

// Build scoped values.yaml: { chartName: { ...overrides } }
// Must use {} not null — null causes "type mismatch" in Helm templates
function buildStageValues(chartName, overrides) {
  const obj = kvArrayToObject(overrides)
  return { [chartName]: Object.keys(obj).length ? obj : {} }
}

export default function GitopsEditor() {
  const [product, setProductName]      = useState('')
  const [editingProduct, setEditProduct] = useState(false)
  const [productInput, setProductInput]  = useState('')
  const [sites, setSites]              = useState([])
  const [relunits, setRelunits]        = useState({})
  const [selection, setSelection]      = useState(null) // { site, relunit, stage }
  const [systems, setSystems]          = useState({})

  // Add UI state
  const [addSite, setAddSite]          = useState(false)
  const [addSiteVal, setAddSiteVal]    = useState('')
  const [addRelunit, setAddRelunit]    = useState(null)
  const [addRelVal, setAddRelVal]      = useState('')

  // Stage form
  const [stageForm, setStageForm]      = useState({
    systemName: '', systemVersion: '',
    chartName: '', chartSemver: '',   // from system chart's Chart.yaml
    overrides: [],
  })
  const [stageStatus, setStageStatus]  = useState('')

  // Helm render
  const [helmRunning, setHelmRunning]  = useState(false)
  const [helmOutput, setHelmOutput]    = useState('')
  const [helmOk, setHelmOk]           = useState(null)

  // Enabled stages cache: { "site/rel/stage": bool }
  const [enabledStages, setEnabledStages] = useState({})

  const loadAll = useCallback(async () => {
    const [p, sys] = await Promise.all([getProduct(), listTemplates('system')])
    setSystems(sys)
    const pname = p.name || ''
    setProductName(pname)
    setProductInput(pname)
    if (!pname) { setSites([]); setRelunits({}); return }
    const s = await listSites(pname)
    setSites(s)
    const rmap = {}
    for (const site of s) rmap[site] = await listRelunits(pname, site)
    setRelunits(rmap)
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  // Refresh enabled-stages map whenever tree changes
  useEffect(() => {
    async function checkStages() {
      if (!product) return
      const map = {}
      for (const site of sites) {
        for (const rel of (relunits[site] || [])) {
          for (const stage of STAGES) {
            const d = await getStage(product, site, rel, stage)
            map[`${site}/${rel}/${stage}`] = d.exists
          }
        }
      }
      setEnabledStages(map)
    }
    checkStages()
  }, [product, sites, relunits])

  // When system name or version changes, fetch chart metadata
  useEffect(() => {
    async function fetchMeta() {
      const { systemName, systemVersion } = stageForm
      if (!systemName || !systemVersion) {
        setStageForm(f => ({ ...f, chartName: '', chartSemver: '' }))
        return
      }
      const meta = await getSystemChartMeta(systemName, systemVersion)
      if (meta) {
        setStageForm(f => ({
          ...f,
          chartName: meta.name,
          chartSemver: String(meta.version),
        }))
      }
    }
    fetchMeta()
  }, [stageForm.systemName, stageForm.systemVersion])

  // ── Product actions ────────────────────────────────────────────────────────

  async function handleSetProduct() {
    if (!productInput.trim()) return
    await setProduct(product, productInput.trim())
    setEditProduct(false)
    await loadAll()
  }

  // ── Site / relunit actions ────────────────────────────────────────────────

  async function handleAddSite() {
    if (!addSiteVal.trim() || !product) return
    await createSite(product, addSiteVal.trim())
    setAddSiteVal(''); setAddSite(false)
    await loadAll()
  }

  async function handleDeleteSite(site) {
    if (!confirm(`Delete site "${site}" and all its content?`)) return
    await deleteSite(product, site)
    if (selection?.site === site) setSelection(null)
    await loadAll()
  }

  async function handleAddRelunit(site) {
    if (!addRelVal.trim()) return
    await createRelunit(product, site, addRelVal.trim())
    setAddRelunit(null); setAddRelVal('')
    await loadAll()
  }

  async function handleDeleteRelunit(site, relunit) {
    if (!confirm(`Delete relunit "${relunit}"?`)) return
    await deleteRelunit(product, site, relunit)
    if (selection?.site === site && selection?.relunit === relunit) setSelection(null)
    await loadAll()
  }

  // ── Stage actions ─────────────────────────────────────────────────────────

  async function selectStage(site, relunit, stage) {
    setSelection({ site, relunit, stage })
    setHelmOutput(''); setHelmOk(null)
    const d = await getStage(product, site, relunit, stage)
    const p = d.parsed || {}

    // Restore system name + version from Chart.yaml dependency repository URL
    let systemName = ''
    let systemVersion = ''
    let chartName = ''
    const dep = d.chart?.parsed?.dependencies?.[0]
    if (dep?.repository) {
      const m = dep.repository.match(/templates\/system\/([^/]+)\/([^/]+)$/)
      if (m) { systemName = m[1]; systemVersion = m[2] }
      chartName = dep.name || ''
    }

    // Extract stored values from under the chartName key (scoped values)
    const overrideKey = chartName || Object.keys(p)[0] || ''
    const overrides = p[overrideKey]
      ? objectToKvArray(p[overrideKey])
      : []

    setStageForm(f => ({
      ...f,
      systemName,
      systemVersion,
      chartName,
      chartSemver: dep?.version ? String(dep.version) : '',
      overrides,
    }))
  }

  async function handleToggleStage(site, relunit, stage, currentlyEnabled) {
    if (currentlyEnabled) {
      if (!confirm(`Disable stage ${stage}?`)) return
      await deleteStage(product, site, relunit, stage)
      if (selection?.site === site && selection?.relunit === relunit && selection?.stage === stage) {
        setSelection(null); setHelmOutput(''); setHelmOk(null)
      }
    } else {
      // Enable: create minimal Chart.yaml + empty values.yaml
      await saveStage(product, site, relunit, stage, {}, null)
      await selectStage(site, relunit, stage)
    }
    // Refresh enabled map
    setEnabledStages(prev => ({ ...prev, [`${site}/${relunit}/${stage}`]: !currentlyEnabled }))
  }

  async function handleSaveStage() {
    if (!selection) return
    const { site, relunit, stage } = selection
    const { systemName, systemVersion, chartName, chartSemver, overrides } = stageForm

    // Build values.yaml with chart-name-scoped overrides
    const valData = buildStageValues(chartName || 'system', overrides)

    // Build Chart.yaml if system is selected
    let chartData = null
    if (systemName && systemVersion && chartName) {
      chartData = buildStageChart(relunit, stage, chartName, systemVersion, systemName, systemVersion)
    }

    await saveStage(product, site, relunit, stage, valData, chartData)
    setStageStatus('Saved')
    setTimeout(() => setStageStatus(''), 2000)
  }

  async function handleRunHelm() {
    if (!selection || !product) return
    setHelmRunning(true)
    setHelmOutput('Running...')
    setHelmOk(null)
    const { site, relunit, stage } = selection
    const result = await runHelmRender(product, site, relunit, stage)
    setHelmRunning(false)
    setHelmOk(result.ok)
    setHelmOutput(result.output || '')
  }

  const systemVersions = stageForm.systemName ? (systems[stageForm.systemName] || []) : []

  const systemRef = stageForm.systemName && stageForm.systemVersion
    ? `system/${stageForm.systemName}/${stageForm.systemVersion}`
    : null

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="gitops-layout">
      {/* ── Tree panel ── */}
      <div className="gitops-tree">
        {/* Product */}
        <div style={{ padding: '10px 14px', borderBottom: '1px solid #e5e7eb', marginBottom: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
            Product
          </div>
          {editingProduct ? (
            <div className="inline-add">
              <input type="text" value={productInput} autoFocus
                onChange={e => setProductInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSetProduct(); if (e.key === 'Escape') setEditProduct(false) }} />
              <button className="btn btn-primary btn-sm" onClick={handleSetProduct}>OK</button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 14, color: product ? '#1a1a2e' : '#9ca3af' }}>
                {product || '— not set —'}
              </span>
              <button className="btn btn-ghost btn-sm" onClick={() => setEditProduct(true)}>✏️</button>
            </div>
          )}
        </div>

        {/* Sites */}
        {product && (
          <>
            {sites.map(site => (
              <div key={site}>
                <div className="tree-node indent-1" style={{ justifyContent: 'space-between' }}>
                  <span>📁 {site}</span>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn btn-ghost btn-icon" style={{ fontSize: 12, padding: '2px 6px' }}
                      onClick={() => { setAddRelunit(site); setAddRelVal('') }} title="Add relunit">+</button>
                    <button className="btn btn-ghost btn-icon" style={{ fontSize: 12, padding: '2px 6px', color: '#dc2626' }}
                      onClick={() => handleDeleteSite(site)} title="Delete site">×</button>
                  </div>
                </div>

                {addRelunit === site && (
                  <div className="inline-add" style={{ paddingLeft: 28 }}>
                    <input type="text" value={addRelVal} placeholder="relunit name" autoFocus
                      onChange={e => setAddRelVal(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleAddRelunit(site); if (e.key === 'Escape') setAddRelunit(null) }} />
                    <button className="btn btn-primary btn-sm" onClick={() => handleAddRelunit(site)}>Add</button>
                  </div>
                )}

                {(relunits[site] || []).map(rel => (
                  <div key={rel}>
                    <div className="tree-node indent-2" style={{ justifyContent: 'space-between' }}>
                      <span>📂 {rel}</span>
                      <button className="btn btn-ghost btn-icon" style={{ fontSize: 12, padding: '2px 6px', color: '#dc2626' }}
                        onClick={() => handleDeleteRelunit(site, rel)} title="Delete relunit">×</button>
                    </div>

                    {STAGES.map(stage => {
                      const key = `${site}/${rel}/${stage}`
                      const enabled = enabledStages[key]
                      const isSelected = selection?.site === site && selection?.relunit === rel && selection?.stage === stage
                      return (
                        <div key={stage}
                          className={`tree-node stage-node${enabled ? ' enabled' : ''}${isSelected ? ' selected' : ''}`}
                          style={{ justifyContent: 'space-between' }}
                        >
                          <span style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: enabled ? 'pointer' : 'default' }}
                            onClick={() => enabled && selectStage(site, rel, stage)}>
                            <span className={`stage-dot${enabled ? ' enabled' : ''}`}></span>
                            {stage}
                          </span>
                          <button
                            className="btn btn-ghost btn-sm"
                            style={{ fontSize: 11, padding: '1px 6px', color: enabled ? '#dc2626' : '#059669' }}
                            onClick={() => handleToggleStage(site, rel, stage, !!enabled)}
                          >
                            {enabled ? 'off' : 'on'}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            ))}

            {addSite ? (
              <div className="inline-add" style={{ marginTop: 4 }}>
                <input type="text" value={addSiteVal} placeholder="site name" autoFocus
                  onChange={e => setAddSiteVal(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleAddSite(); if (e.key === 'Escape') setAddSite(false) }} />
                <button className="btn btn-primary btn-sm" onClick={handleAddSite}>Add</button>
              </div>
            ) : (
              <div style={{ padding: '8px 14px' }}>
                <button className="btn btn-ghost btn-sm" onClick={() => { setAddSite(true); setAddSiteVal('') }}>+ Add Site</button>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Detail panel ── */}
      <div className="gitops-detail">
        {!selection ? (
          <div className="empty-state">
            <div className="empty-state-icon">🚀</div>
            <p>
              {!product
                ? 'Set a product name on the left to get started.'
                : 'Toggle a stage "on" then click it to edit.'}
            </p>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="form-card">
              <div className="form-card-title">
                <span>
                  {product} / {selection.site} / {selection.relunit} / {selection.stage}
                </span>
                {stageStatus && <span className="tag">{stageStatus}</span>}
              </div>

              {/* System ref badge */}
              {systemRef && (
                <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' }}>ref:</span>
                  <code style={{ background: '#f3f4f6', padding: '2px 8px', borderRadius: 4, fontSize: 12, color: '#7c3aed' }}>
                    {systemRef}
                  </code>
                </div>
              )}

              <p className="text-muted" style={{ marginBottom: 12 }}>
                Output: <code>gitops-deploy/{product}/{selection.site}/{selection.relunit}/{selection.stage}/</code>
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="form-row">
                  <label>System Template</label>
                  <select value={stageForm.systemName}
                    onChange={e => setStageForm(f => ({ ...f, systemName: e.target.value, systemVersion: '', chartName: '', chartSemver: '' }))}>
                    <option value="">— select system —</option>
                    {Object.keys(systems).map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <div className="form-row">
                  <label>Version</label>
                  <select value={stageForm.systemVersion}
                    onChange={e => setStageForm(f => ({ ...f, systemVersion: e.target.value, chartName: '', chartSemver: '' }))}>
                    <option value="">— select version —</option>
                    {systemVersions.map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
              </div>

              {/* Generated Chart.yaml preview */}
              {stageForm.chartName && stageForm.systemVersion && (
                <div style={{ marginTop: 12 }}>
                  <div className="preview-label">Auto-generated Chart.yaml</div>
                  <div className="preview-box" style={{ fontSize: 12 }}>
                    {[
                      `apiVersion: v2`,
                      `name: ${selection.relunit}-${selection.stage}`,
                      `version: 0.1.0`,
                      `dependencies:`,
                      `  - name: ${stageForm.chartName}`,
                      `    version: "${stageForm.chartSemver}"`,
                      `    repository: "file://../../../../../templates/system/${stageForm.systemName}/${stageForm.systemVersion}"`,
                    ].join('\n')}
                  </div>
                </div>
              )}
            </div>

            {/* Override values */}
            <div className="form-card">
              <div className="form-card-title">
                Deploy Override Values
                {stageForm.chartName && (
                  <span className="text-muted" style={{ fontSize: 12 }}>
                    scoped under <code>{stageForm.chartName}:</code>
                  </span>
                )}
              </div>
              <KVEditor
                rows={stageForm.overrides}
                onChange={rows => setStageForm(f => ({ ...f, overrides: rows }))}
                keyPlaceholder="key" valuePlaceholder="value"
              />
            </div>

            {/* Actions */}
            <div className="btn-row" style={{ marginBottom: 16 }}>
              <button className="btn btn-primary" onClick={handleSaveStage}
                disabled={!stageForm.systemName || !stageForm.systemVersion}>
                Save values.yaml + Chart.yaml
              </button>
              <button className="btn btn-secondary" onClick={handleRunHelm}
                disabled={helmRunning}
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {helmRunning ? '⏳ Running…' : '▶ Run helm template'}
              </button>
              <button className="btn btn-danger"
                onClick={() => handleToggleStage(selection.site, selection.relunit, selection.stage, true)}>
                Disable Stage
              </button>
            </div>

            {/* Helm output */}
            {helmOutput && (
              <div className="form-card">
                <div className="form-card-title">
                  Helm Output
                  {helmOk === true  && <span className="tag" style={{ background: '#d1fae5', color: '#059669' }}>✓ success</span>}
                  {helmOk === false && <span className="tag" style={{ background: '#fee2e2', color: '#dc2626' }}>✗ error</span>}
                </div>
                <div className="preview-box" style={{
                  maxHeight: 500, overflowY: 'auto', fontSize: 12,
                  color: helmOk === false ? '#fca5a5' : '#a5f3fc',
                  whiteSpace: 'pre',
                }}>
                  {helmOutput}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
