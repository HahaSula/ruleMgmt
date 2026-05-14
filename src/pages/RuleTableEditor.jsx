import { useState, useEffect } from 'react'
import { getRuleSets, saveRuleSets } from '../utils/api'

// ── Tree helpers ──────────────────────────────────────────────────────────────

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function findNode(nodes, id) {
  for (const n of nodes) {
    if (n.id === id) return n
    const found = findNode(n.children || [], id)
    if (found) return found
  }
  return null
}

function mapTree(nodes, fn) {
  return nodes.map(n => fn({ ...n, children: mapTree(n.children || [], fn) }))
}

function deleteFromTree(nodes, id) {
  return nodes
    .filter(n => n.id !== id)
    .map(n => ({ ...n, children: deleteFromTree(n.children || [], id) }))
}

function nodePath(nodes, id, path = []) {
  for (const n of nodes) {
    const cur = [...path, n.name]
    if (n.id === id) return cur
    const found = nodePath(n.children || [], id, cur)
    if (found) return found
  }
  return null
}

function makeNode(name = 'New') {
  return {
    id: uid(),
    name,
    children: [],
    template: { globalVars: [], rules: [] },
    rows: [],
  }
}

function extractColumns(template) {
  const seen = new Set(['groupName'])
  const cols = ['groupName']   // groupName is always first
  // global vars come before per-rule vars
  for (const v of (template?.globalVars || [])) {
    if (v.key?.trim() && !seen.has(v.key)) { seen.add(v.key); cols.push(v.key) }
  }
  for (const rule of (template?.rules || [])) {
    for (const v of (rule.vars || [])) {
      if (v.key?.trim() && !seen.has(v.key)) { seen.add(v.key); cols.push(v.key) }
    }
  }
  return cols
}

// ── Tree node component ───────────────────────────────────────────────────────

function TreeNode({ node, depth, selectedId, mode, onMode, onAddChild, onDelete, renaming, onRenameStart, onRenameEnd }) {
  const [nameInput, setNameInput] = useState(node.name)
  const isSelected = node.id === selectedId
  const isRenaming = renaming === node.id

  useEffect(() => { setNameInput(node.name) }, [node.name])

  return (
    <div>
      <div
        className={`tree-node${isSelected ? ' active' : ''}`}
        style={{ paddingLeft: 12 + depth * 16 }}
      >
        <span className="tree-node-icon">{(node.children || []).length > 0 ? '▸' : '●'}</span>

        {isRenaming ? (
          <input
            className="tree-rename-input"
            autoFocus
            value={nameInput}
            onChange={e => setNameInput(e.target.value)}
            onBlur={() => onRenameEnd(node.id, nameInput)}
            onKeyDown={e => {
              if (e.key === 'Enter') onRenameEnd(node.id, nameInput)
              if (e.key === 'Escape') onRenameEnd(node.id, null)
            }}
          />
        ) : (
          <span className="tree-node-label">{node.name}</span>
        )}

        <span className="tree-node-actions">
          {(node.children || []).length === 0 && (<>
            <button
              className={`tree-mode-btn${isSelected && mode === 'template' ? ' active' : ''}`}
              title="Edit Template"
              onClick={() => onMode(node.id, 'template')}
            >Template</button>
            <button
              className={`tree-mode-btn${isSelected && mode === 'table' ? ' active' : ''}`}
              title="Edit Table"
              onClick={() => onMode(node.id, 'table')}
            >Table</button>
          </>)}
          <button title="Rename" onClick={() => onRenameStart(node.id)}>✏</button>
          <button title="Add child" onClick={() => onAddChild(node.id)}>+</button>
          <button title="Delete" onClick={() => onDelete(node.id)}>×</button>
        </span>
      </div>

      {(node.children || []).map(child => (
        <TreeNode
          key={child.id}
          node={child}
          depth={depth + 1}
          selectedId={selectedId}
          mode={mode}
          onMode={onMode}
          onAddChild={onAddChild}
          onDelete={onDelete}
          renaming={renaming}
          onRenameStart={onRenameStart}
          onRenameEnd={onRenameEnd}
        />
      ))}
    </div>
  )
}

// ── YAML preview builder ──────────────────────────────────────────────────────

function buildTemplatePreview(template, groupName) {
  const name = groupName || '(unnamed)'
  let yaml = `apiVersion: monitoring.coreos.com/v1\n`
  yaml += `kind: PrometheusRule\n`
  yaml += `metadata:\n`
  yaml += `  name: {{ .groupName }}\nspec:\n  groups:\n`
  yaml += `    - name: {{ .groupName }}\n`
  yaml += `      # groupName = ${name}\n`

  const gvars = (template?.globalVars || []).filter(v => v.key?.trim())
  if (gvars.length) {
    yaml += `      # global variables:\n`
    for (const v of gvars) yaml += `      #   {{ .${v.key} }}  default: ${v.default ?? ''}\n`
  }

  if (!(template?.rules?.length)) {
    yaml += `      rules: []\n`
    return yaml.trimEnd()
  }

  yaml += `      rules:\n`
  for (const rule of template.rules) {
    const alertName = rule.ruleName || '(unnamed)'
    yaml += `        - alert: ${alertName}\n`
    const expr = rule.expr?.trim() || ''
    yaml += `          expr: ${expr ? JSON.stringify(expr) : '"# define expression"'}\n`
    if (rule.for) yaml += `          for: ${rule.for}\n`
    yaml += `          labels:\n`
    yaml += `            severity: ${rule.severity || 'warning'}\n`
    if (rule.vars?.some(v => v.key?.trim())) {
      yaml += `          # rule variables:\n`
      for (const v of rule.vars) {
        if (v.key?.trim()) yaml += `          #   ${v.key}: ${v.default ?? ''}\n`
      }
    }
  }

  return yaml.trimEnd()
}

// ── Template editor ───────────────────────────────────────────────────────────

function TemplateEditor({ node, path, onChange }) {
  const template = node.template || { rules: [] }
  const groupName = (path || []).join('.')

  function updateRule(ruleId, patch) {
    onChange({
      rules: template.rules.map(r => r.id === ruleId ? { ...r, ...patch } : r)
    })
  }

  function addRule() {
    onChange({ rules: [...template.rules, { id: uid(), ruleName: '', expr: '', for: '5m', severity: 'warning', vars: [] }] })
  }

  function deleteRule(ruleId) {
    onChange({ rules: template.rules.filter(r => r.id !== ruleId) })
  }

  function addVar(ruleId) {
    updateRule(ruleId, {
      vars: [...(template.rules.find(r => r.id === ruleId)?.vars || []), { id: uid(), key: '', default: '' }]
    })
  }

  function updateVar(ruleId, varId, patch) {
    const rule = template.rules.find(r => r.id === ruleId)
    updateRule(ruleId, { vars: (rule?.vars || []).map(v => v.id === varId ? { ...v, ...patch } : v) })
  }

  function deleteVar(ruleId, varId) {
    const rule = template.rules.find(r => r.id === ruleId)
    updateRule(ruleId, { vars: (rule?.vars || []).filter(v => v.id !== varId) })
  }

  const preview = buildTemplatePreview(template, groupName)

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      {/* Form */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: '#0369a1', background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 6, padding: '8px 12px', marginBottom: 12 }}>
          <code>{'{{ .groupName }}'}</code> is a built-in variable usable in any rule's expr.
          It is set per row in the Table view (default: <strong>{groupName || 'tree path'}</strong>).
        </div>

        {/* Global Variables */}
        <div className="form-card" style={{ marginBottom: 12 }}>
          <div className="form-card-title">
            Global Variables
            <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400 }}>shared across all rules, become table columns</span>
          </div>
          {(template.globalVars || []).length > 0 && (
            <table className="kv-table" style={{ marginBottom: 8 }}>
              <colgroup><col /><col /><col style={{ width: 32 }} /></colgroup>
              <thead><tr><th>Key</th><th>Default value</th><th></th></tr></thead>
              <tbody>
                {(template.globalVars || []).map(v => (
                  <tr key={v.id}>
                    <td>
                      <input type="text" value={v.key} placeholder="e.g. env"
                        onChange={e => onChange({ globalVars: template.globalVars.map(gv => gv.id === v.id ? { ...gv, key: e.target.value } : gv) })} />
                    </td>
                    <td>
                      <input type="text" value={v.default} placeholder="default"
                        onChange={e => onChange({ globalVars: template.globalVars.map(gv => gv.id === v.id ? { ...gv, default: e.target.value } : gv) })} />
                    </td>
                    <td>
                      <button className="btn btn-ghost btn-icon"
                        onClick={() => onChange({ globalVars: template.globalVars.filter(gv => gv.id !== v.id) })}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <button className="btn btn-ghost btn-sm"
            onClick={() => onChange({ globalVars: [...(template.globalVars || []), { id: uid(), key: '', default: '' }] })}>
            + Add Global Variable
          </button>
        </div>

        {template.rules.length === 0 && (
          <div style={{ color: '#9ca3af', fontSize: 12, marginBottom: 12 }}>
            No rules yet. Click + Add Rule below.
          </div>
        )}

        {template.rules.map((rule, idx) => (
          <div key={rule.id} className="form-card" style={{ marginBottom: 12 }}>
            <div className="form-card-title">
              Rule {idx + 1}
              <button className="btn btn-ghost btn-sm" style={{ color: '#dc2626' }} onClick={() => deleteRule(rule.id)}>Delete</button>
            </div>

            {/* Alert name / for / severity row */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 1fr', gap: 8, marginBottom: 10 }}>
              <div className="form-row" style={{ margin: 0 }}>
                <label>Alert Name</label>
                <input type="text" value={rule.ruleName} placeholder="e.g. HighCPUUsage"
                  onChange={e => updateRule(rule.id, { ruleName: e.target.value })} />
              </div>
              <div className="form-row" style={{ margin: 0 }}>
                <label>For</label>
                <input type="text" value={rule.for ?? '5m'} placeholder="5m"
                  onChange={e => updateRule(rule.id, { for: e.target.value })} />
              </div>
              <div className="form-row" style={{ margin: 0 }}>
                <label>Severity <span style={{ color: '#9ca3af', fontWeight: 400 }}>(label value)</span></label>
                <input type="text" value={rule.severity ?? 'warning'} placeholder="warning / critical / {{ .severity }}"
                  onChange={e => updateRule(rule.id, { severity: e.target.value })} />
              </div>
            </div>

            {/* Expr */}
            <div className="form-row" style={{ marginBottom: 10 }}>
              <label>Expr <span style={{ color: '#9ca3af', fontWeight: 400 }}>(PromQL — use {'{{ .varKey }}'} for variables)</span></label>
              <textarea
                value={rule.expr ?? ''}
                placeholder={'e.g. avg(cpu_usage{job="mysql"}) > {{ .threshold }}'}
                rows={2}
                style={{ fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
                onChange={e => updateRule(rule.id, { expr: e.target.value })}
              />
            </div>

            {/* Variables */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                Variables <span style={{ color: '#9ca3af', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— become table columns</span>
              </div>
              {rule.vars.length > 0 && (
                <table className="kv-table" style={{ marginBottom: 6 }}>
                  <colgroup><col /><col /><col style={{ width: 32 }} /></colgroup>
                  <thead><tr><th>Key</th><th>Default value</th><th></th></tr></thead>
                  <tbody>
                    {rule.vars.map(v => (
                      <tr key={v.id}>
                        <td>
                          <input type="text" value={v.key} placeholder="threshold"
                            onChange={e => updateVar(rule.id, v.id, { key: e.target.value })} />
                        </td>
                        <td>
                          <input type="text" value={v.default} placeholder="default"
                            onChange={e => updateVar(rule.id, v.id, { default: e.target.value })} />
                        </td>
                        <td>
                          <button className="btn btn-ghost btn-icon" onClick={() => deleteVar(rule.id, v.id)}>×</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <button className="btn btn-ghost btn-sm" onClick={() => addVar(rule.id)}>+ Add Variable</button>
            </div>
          </div>
        ))}

        <button className="btn btn-secondary btn-sm" onClick={addRule}>+ Add Rule</button>
      </div>

      {/* Preview */}
      <div style={{ width: 360, flexShrink: 0, position: 'sticky', top: 0 }}>
        <div className="form-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '10px 14px', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid #e5e7eb' }}>
            YAML Preview
          </div>
          <pre className="preview-box" style={{ margin: 0, borderRadius: 0, maxHeight: 520, overflowY: 'auto', fontSize: 11 }}>{preview}</pre>
        </div>
      </div>
    </div>
  )
}

// ── Table editor ──────────────────────────────────────────────────────────────

function TableEditor({ node, path, onChange }) {
  const columns = extractColumns(node.template)
  const rows = node.rows || []

  function addRow() {
    const vars = { groupName: path ? path.join('.') : '' }
    for (const col of columns) {
      if (col === 'groupName') continue
      // check global vars first
      const gv = (node.template?.globalVars || []).find(v => v.key === col)
      if (gv) { vars[col] = gv.default ?? ''; continue }
      // then per-rule vars
      for (const rule of (node.template?.rules || [])) {
        const v = rule.vars?.find(v => v.key === col)
        if (v) { vars[col] = v.default ?? ''; break }
      }
    }
    onChange({ rows: [...rows, { id: uid(), vars }] })
  }

  function updateRow(rowId, patch) {
    onChange({ rows: rows.map(r => r.id === rowId ? { ...r, ...patch } : r) })
  }

  function deleteRow(rowId) {
    onChange({ rows: rows.filter(r => r.id !== rowId) })
  }

  if (columns.length === 0) {
    return (
      <div className="form-card">
        <div style={{ color: '#9ca3af', fontSize: 13 }}>
          No variables defined yet. Go to <strong>Edit Template</strong> and add variables to the rules first.
        </div>
      </div>
    )
  }

  return (
    <div className="form-card">
      <div className="form-card-title">
        Rule Group Instances
        <button className="btn btn-ghost btn-sm" onClick={addRow}>+ Add Row</button>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="rule-table">
          <thead>
            <tr>
              {columns.map(col => (
                <th key={col} style={{ minWidth: col === 'groupName' ? 200 : 120 }}>{col}</th>
              ))}
              <th style={{ width: 36 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length + 2} style={{ color: '#9ca3af', textAlign: 'center', padding: '16px 0', fontSize: 12 }}>
                  No rows yet. Click + Add Row.
                </td>
              </tr>
            ) : rows.map(row => (
              <tr key={row.id}>
                {columns.map(col => (
                  <td key={col}>
                    <input
                      type="text"
                      value={row.vars?.[col] ?? ''}
                      onChange={e => updateRow(row.id, { vars: { ...row.vars, [col]: e.target.value } })}
                    />
                  </td>
                ))}
                <td>
                  <button className="btn btn-ghost btn-icon" onClick={() => deleteRow(row.id)} title="Delete row">×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Rule set list item ────────────────────────────────────────────────────────

function RuleSetItem({ ruleSet, selected, renamingId, onSelect, onRenameStart, onRenameEnd, onDelete }) {
  const [input, setInput] = useState(ruleSet.name)
  const isRenaming = renamingId === ruleSet.id

  useEffect(() => { setInput(ruleSet.name) }, [ruleSet.name])

  return (
    <div className={`rule-set-item${selected ? ' active' : ''}`} onClick={() => !isRenaming && onSelect(ruleSet.id)}>
      {isRenaming ? (
        <input
          className="tree-rename-input"
          autoFocus
          value={input}
          onChange={e => setInput(e.target.value)}
          onBlur={() => onRenameEnd(ruleSet.id, input)}
          onKeyDown={e => {
            if (e.key === 'Enter') onRenameEnd(ruleSet.id, input)
            if (e.key === 'Escape') onRenameEnd(ruleSet.id, null)
          }}
          onClick={e => e.stopPropagation()}
        />
      ) : (
        <span className="rule-set-name">{ruleSet.name}</span>
      )}
      <span className="tree-node-actions">
        <button title="Rename" onClick={e => { e.stopPropagation(); onRenameStart(ruleSet.id) }}>✏</button>
        <button title="Delete" onClick={e => { e.stopPropagation(); onDelete(ruleSet.id) }}>×</button>
      </span>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

function migrateData(raw) {
  // migrate old { tree: [] } format to { ruleSets: [] }
  if (raw?.ruleSets) return raw
  if (raw?.tree) return { ruleSets: [{ id: uid(), name: 'Default', tree: raw.tree }] }
  return { ruleSets: [] }
}

export default function RuleTableEditor() {
  const [data, setData] = useState({ ruleSets: [] })
  const [selectedSetId, setSelectedSetId] = useState(null)
  const [selectedNodeId, setSelectedNodeId] = useState(null)
  const [mode, setMode] = useState('template')
  const [renamingSet, setRenamingSet] = useState(null)
  const [renamingNode, setRenamingNode] = useState(null)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const [col1Folded, setCol1Folded] = useState(false)
  const [col2Folded, setCol2Folded] = useState(false)

  useEffect(() => {
    getRuleSets().then(raw => {
      const d = migrateData(raw)
      setData(d)
      if (d.ruleSets.length > 0) setSelectedSetId(d.ruleSets[0].id)
    })
  }, [])

  const selectedSet = data.ruleSets.find(s => s.id === selectedSetId) ?? null
  const currentTree = selectedSet?.tree ?? []
  const selectedNode = selectedNodeId ? findNode(currentTree, selectedNodeId) : null
  const selectedPath = selectedNodeId ? nodePath(currentTree, selectedNodeId) : null

  // ── Rule set operations ──────────────────────────────────────────────────────

  function addRuleSet() {
    const s = { id: uid(), name: 'New Rules', tree: [] }
    setData(prev => ({ ...prev, ruleSets: [...prev.ruleSets, s] }))
    setSelectedSetId(s.id)
    setSelectedNodeId(null)
    setRenamingSet(s.id)
  }

  function deleteRuleSet(id) {
    if (!window.confirm('Delete this rule set and all its nodes?')) return
    setData(prev => ({ ...prev, ruleSets: prev.ruleSets.filter(s => s.id !== id) }))
    if (selectedSetId === id) { setSelectedSetId(null); setSelectedNodeId(null) }
  }

  function renameRuleSet(id, newName) {
    setRenamingSet(null)
    if (!newName?.trim()) return
    setData(prev => ({
      ...prev,
      ruleSets: prev.ruleSets.map(s => s.id === id ? { ...s, name: newName.trim() } : s)
    }))
  }

  function updateSetTree(patch) {
    if (!selectedSetId) return
    setData(prev => ({
      ...prev,
      ruleSets: prev.ruleSets.map(s => s.id === selectedSetId ? { ...s, ...patch } : s)
    }))
  }

  // ── Tree node operations (scoped to selected rule set) ───────────────────────

  function updateNode(nodeId, patch) {
    updateSetTree({ tree: mapTree(currentTree, n => n.id === nodeId ? { ...n, ...patch } : n) })
  }

  function handleMode(nodeId, newMode) {
    setSelectedNodeId(nodeId)
    setMode(newMode)
  }

  function addRootNode() {
    const node = makeNode()
    updateSetTree({ tree: [...currentTree, node] })
    setRenamingNode(node.id)
  }

  function addChildNode(parentId) {
    const node = makeNode()
    updateSetTree({ tree: mapTree(currentTree, n =>
      n.id === parentId ? { ...n, children: [...(n.children || []), node] } : n
    )})
    setRenamingNode(node.id)
  }

  function deleteNode(id) {
    if (!window.confirm('Delete this node and all its children and rows?')) return
    updateSetTree({ tree: deleteFromTree(currentTree, id) })
    if (selectedNodeId === id) setSelectedNodeId(null)
  }

  function handleNodeRenameEnd(id, newName) {
    setRenamingNode(null)
    if (newName?.trim()) updateNode(id, { name: newName.trim() })
  }

  async function handleSave() {
    setSaving(true)
    setStatus('')
    try {
      await saveRuleSets(data)
      setStatus('Saved.')
    } catch {
      setStatus('Save failed.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="editor-layout">

      {/* Col 1: Rule Sets list */}
      {col1Folded ? (
        <div className="panel-fold-strip" onClick={() => setCol1Folded(false)} title="Expand Rules">
          <span className="panel-fold-label">Rules</span>
          <span className="panel-fold-icon">›</span>
        </div>
      ) : (
        <div className="editor-list" style={{ width: 200, borderRight: '1px solid #e5e7eb' }}>
          <div className="editor-list-header">
            Rules
            <span style={{ display: 'flex', gap: 4 }}>
              <button className="btn btn-ghost btn-sm" onClick={addRuleSet}>+</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setCol1Folded(true)} title="Collapse">‹</button>
            </span>
          </div>
          <div className="editor-list-body">
            {data.ruleSets.length === 0 && (
              <div style={{ padding: '12px 14px', color: '#9ca3af', fontSize: 12 }}>
                No rule sets. Click + to add.
              </div>
            )}
            {data.ruleSets.map(s => (
              <RuleSetItem
                key={s.id}
                ruleSet={s}
                selected={s.id === selectedSetId}
                renamingId={renamingSet}
                onSelect={id => { setSelectedSetId(id); setSelectedNodeId(null) }}
                onRenameStart={setRenamingSet}
                onRenameEnd={renameRuleSet}
                onDelete={deleteRuleSet}
              />
            ))}
          </div>
        </div>
      )}

      {/* Col 2: Tree for selected rule set */}
      {col2Folded ? (
        <div className="panel-fold-strip" onClick={() => setCol2Folded(false)} title="Expand Tree">
          <span className="panel-fold-label">{selectedSet?.name ?? 'Tree'}</span>
          <span className="panel-fold-icon">›</span>
        </div>
      ) : (
        <div className="editor-list" style={{ width: 280, borderRight: '1px solid #e5e7eb' }}>
          <div className="editor-list-header">
            {selectedSet ? selectedSet.name : 'Tree'}
            <span style={{ display: 'flex', gap: 4 }}>
              {selectedSet && <button className="btn btn-ghost btn-sm" onClick={addRootNode}>+ Node</button>}
              <button className="btn btn-ghost btn-sm" onClick={() => setCol2Folded(true)} title="Collapse">‹</button>
            </span>
          </div>
          <div className="editor-list-body">
            {!selectedSet ? (
              <div style={{ padding: '12px 14px', color: '#9ca3af', fontSize: 12 }}>
                Select a rule set first.
              </div>
            ) : currentTree.length === 0 ? (
              <div style={{ padding: '12px 14px', color: '#9ca3af', fontSize: 12 }}>
                No nodes yet. Click + Node.
              </div>
            ) : currentTree.map(node => (
              <TreeNode
                key={node.id}
                node={node}
                depth={0}
                selectedId={selectedNodeId}
                mode={mode}
                onMode={handleMode}
                onAddChild={addChildNode}
                onDelete={deleteNode}
                renaming={renamingNode}
                onRenameStart={setRenamingNode}
                onRenameEnd={handleNodeRenameEnd}
              />
            ))}
          </div>
        </div>
      )}

      {/* Col 3: Template / Table editor */}
      <div className="editor-form">
        {!selectedNode ? (
          <div style={{ color: '#9ca3af', marginTop: 60, textAlign: 'center', fontSize: 13 }}>
            {selectedSet
              ? <>Click <strong>Template</strong> or <strong>Table</strong> on a leaf node.</>
              : 'Select a rule set from the left panel.'}
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: '#374151' }}>
                {selectedSet?.name} › {selectedPath?.join(' › ')}
              </h2>
              <span style={{ fontSize: 12, background: mode === 'template' ? '#ede9fe' : '#dbeafe', color: mode === 'template' ? '#7c3aed' : '#1d4ed8', borderRadius: 4, padding: '2px 8px', fontWeight: 600 }}>
                {mode === 'template' ? 'Edit Template' : 'Edit Table'}
              </span>
              <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving} style={{ marginLeft: 'auto' }}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              {status && <span style={{ fontSize: 12, color: '#6b7280' }}>{status}</span>}
            </div>

            {mode === 'template' && (
              <TemplateEditor
                node={selectedNode}
                path={selectedPath}
                onChange={patch => updateNode(selectedNodeId, { template: { ...(selectedNode.template || {}), ...patch } })}
              />
            )}

            {mode === 'table' && (
              <TableEditor
                node={selectedNode}
                path={selectedPath}
                onChange={patch => updateNode(selectedNodeId, patch)}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}
