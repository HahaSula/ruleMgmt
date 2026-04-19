// Generic key-value row editor
// rows: [{key, value}]   onChange: (rows) => void
export default function KVEditor({ rows, onChange, keyPlaceholder = 'key', valuePlaceholder = 'value' }) {
  function update(i, field, val) {
    const next = rows.map((r, idx) => idx === i ? { ...r, [field]: val } : r)
    onChange(next)
  }

  function add() {
    onChange([...rows, { key: '', value: '' }])
  }

  function remove(i) {
    onChange(rows.filter((_, idx) => idx !== i))
  }

  return (
    <div>
      <table className="kv-table">
        <thead>
          <tr>
            <th>{keyPlaceholder}</th>
            <th>{valuePlaceholder}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td>
                <input
                  type="text"
                  value={row.key}
                  placeholder={keyPlaceholder}
                  onChange={e => update(i, 'key', e.target.value)}
                />
              </td>
              <td>
                <input
                  type="text"
                  value={row.value}
                  placeholder={valuePlaceholder}
                  onChange={e => update(i, 'value', e.target.value)}
                />
              </td>
              <td>
                <button className="btn btn-ghost btn-icon" onClick={() => remove(i)} title="Remove">×</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn btn-ghost btn-sm" style={{ marginTop: 6 }} onClick={add}>+ Add row</button>
    </div>
  )
}
