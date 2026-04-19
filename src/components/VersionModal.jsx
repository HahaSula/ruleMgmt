import { useState } from 'react'
import { isValidVersion } from '../utils/templateUtils'

export default function VersionModal({ defaultVersion, onSave, onCancel }) {
  const [version, setVersion] = useState(defaultVersion || 'v1.0.0')
  const valid = isValidVersion(version)

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>Save as Version</h3>
        <div className="form-row">
          <label>Version (e.g. v1.0.0)</label>
          <input
            type="text"
            value={version}
            onChange={e => setVersion(e.target.value)}
            placeholder="v1.0.0"
            autoFocus
          />
          {!valid && version && (
            <span style={{ color: '#dc2626', fontSize: 12 }}>Must be in format v{'{major}'}.{'{minor}'}.{'{patch}'}</span>
          )}
        </div>
        <div className="btn-row">
          <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" disabled={!valid} onClick={() => onSave(version)}>Save</button>
        </div>
      </div>
    </div>
  )
}
