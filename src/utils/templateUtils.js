// Render Go-style template expr with var substitution and int arithmetic
// Supports: {{ .varName }}, {{ .varName + N }}, {{ .varName - N }}, etc.
export function renderExpr(expr, vars) {
  if (!expr) return ''
  // First pass: arithmetic expressions {{ .varName OP N }}
  let result = expr.replace(
    /\{\{\s*\.(\w+)\s*([+\-*/])\s*(\d+(?:\.\d+)?)\s*\}\}/g,
    (match, key, op, rhs) => {
      const val = vars[key]
      if (val === undefined) return match
      const lhs = parseFloat(val)
      const r   = parseFloat(rhs)
      if (isNaN(lhs)) return match
      let res
      if (op === '+') res = lhs + r
      else if (op === '-') res = lhs - r
      else if (op === '*') res = lhs * r
      else if (op === '/') res = r !== 0 ? lhs / r : NaN
      if (isNaN(res)) return match
      return Number.isInteger(res) ? String(res) : res.toFixed(6).replace(/\.?0+$/, '')
    }
  )
  // Second pass: simple substitution {{ .varName }}
  result = result.replace(/\{\{\s*\.(\w+)\s*\}\}/g, (match, key) => {
    const val = vars[key]
    return val !== undefined ? String(val) : match
  })
  return result
}

// Convert [{key, value}] array to plain object; skip empty keys
export function kvArrayToObject(rows) {
  const obj = {}
  for (const { key, value } of rows) {
    if (key.trim()) obj[key.trim()] = value
  }
  return obj
}

// Convert plain object to [{key, value}] array
export function objectToKvArray(obj) {
  if (!obj || typeof obj !== 'object') return []
  return Object.entries(obj).map(([key, value]) => ({ key, value: String(value) }))
}

// Validate semver version string (v1.0.0 format)
export function isValidVersion(v) {
  return /^v\d+\.\d+\.\d+$/.test(v)
}

// Bump patch version string v1.0.0 → v1.0.1
export function bumpPatch(v) {
  const m = v.match(/^v(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return v
  return `v${m[1]}.${m[2]}.${parseInt(m[3]) + 1}`
}

// Get latest version from version array
export function latestVersion(versions) {
  if (!versions || versions.length === 0) return null
  return [...versions].sort().at(-1)
}
