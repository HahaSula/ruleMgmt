import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { fileURLToPath } from 'url'
import { execFile } from 'child_process'
import os from 'os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json())

const REPO_ROOT = __dirname
const TEMPLATES_DIR = path.join(REPO_ROOT, 'templates')
const GITOPS_DIR = path.join(REPO_ROOT, 'gitops-deploy')

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

// ─── Templates ───────────────────────────────────────────────────────────────

// List all templates of a given type → { [name]: [version, ...] }
app.get('/api/templates/:type', async (req, res) => {
  const dir = path.join(TEMPLATES_DIR, req.params.type)
  try {
    const names = await fs.readdir(dir)
    const result = {}
    for (const name of names) {
      const stat = await fs.stat(path.join(dir, name))
      if (!stat.isDirectory()) continue
      const versions = await fs.readdir(path.join(dir, name))
      result[name] = versions.filter(v => v.startsWith('v')).sort()
    }
    res.json(result)
  } catch {
    res.json({})
  }
})

// Get a single template's values.yaml (parsed + raw)
app.get('/api/templates/:type/:name/:version', async (req, res) => {
  const { type, name, version } = req.params
  const file = path.join(TEMPLATES_DIR, type, name, version, 'values.yaml')
  try {
    const content = await fs.readFile(file, 'utf-8')
    res.json({ content, parsed: yaml.load(content) })
  } catch {
    res.status(404).json({ error: 'Not found' })
  }
})

// Helm template file content keyed by chart type
const HELM_TEMPLATES = {
  'alert-suite': `apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: {{ .Values.alertSuite.name }}
  labels:
    app.kubernetes.io/managed-by: Helm
spec:
  groups:
    - name: {{ .Values.alertSuite.name }}
      rules:
        {{- range .Values.alertSuite.rules }}
        - alert: {{ .ruleName }}
          expr: {{ .expr | quote }}
          {{- if .for }}
          for: {{ .for }}
          {{- end }}
          labels:
            severity: {{ .severity }}
            {{- with .labels }}
            {{- range $k, $v := . }}
            {{ $k }}: {{ $v | quote }}
            {{- end }}
            {{- end }}
          annotations:
            {{- if .description }}
            description: {{ .description | quote }}
            {{- end }}
            summary: {{ .ruleName | quote }}
        {{- end }}
`,
  'system': `apiVersion: monitoring.coreos.com/v1alpha1
kind: AlertmanagerConfig
metadata:
  name: {{ .Values.system.alertSuiteName }}
  labels:
    app.kubernetes.io/managed-by: Helm
spec:
  route:
    groupBy:
      - {{ .Values.system.groupLabel | quote }}
    groupWait: 30s
    groupInterval: 5m
    repeatInterval: 12h
    {{- if .Values.system.routes }}
    receiver: {{ (index .Values.system.routes 0).receiver | quote }}
    routes:
      {{- range .Values.system.routes }}
      - matchers:
          - name: severity
            value: {{ .severity | quote }}
        receiver: {{ .receiver | quote }}
      {{- end }}
    {{- else }}
    receiver: "default"
    {{- end }}

  receivers:
    {{- if .Values.receivers }}
    {{- range .Values.receivers }}
    - name: {{ .name | quote }}
      {{- if .webhook_configs }}
      webhookConfigs:
        {{- range .webhook_configs }}
        - url: {{ .url | quote }}
          sendResolved: {{ .send_resolved }}
        {{- end }}
      {{- end }}
      {{- if .email_configs }}
      emailConfigs:
        {{- range .email_configs }}
        - to: {{ .to | quote }}
          from: {{ .from | quote }}
          smarthost: {{ .smarthost | quote }}
          requireTLS: false
        {{- end }}
      {{- end }}
      {{- if .slack_configs }}
      slackConfigs:
        {{- range .slack_configs }}
        - apiURL: {{ .api_url | quote }}
          channel: {{ .channel | quote }}
        {{- end }}
      {{- end }}
      {{- if .pagerduty_configs }}
      pagerdutyConfigs:
        {{- range .pagerduty_configs }}
        - routingKey: {{ .routing_key | quote }}
        {{- end }}
      {{- end }}
    {{- end }}
    {{- else }}
    - name: "default"
    {{- end }}

  {{- if and .Values.alertSuite .Values.alertSuite.inhibit }}
  inhibitRules:
    {{- range .Values.alertSuite.inhibit }}
    - sourceMatch:
        - name: alertname
          value: {{ .sourceRule | quote }}
      targetMatch:
        - name: alertname
          value: {{ .targetRule | quote }}
      equal:
        - namespace
    {{- end }}
  {{- end }}
`,
}

const HELM_TEMPLATE_FILENAMES = {
  'alert-suite': 'prometheus-rule.yaml',
  'system':      'alertmanager-config.yaml',
}

// Save / create a template version
app.post('/api/templates/:type/:name/:version', async (req, res) => {
  const { type, name, version } = req.params
  const dir = path.join(TEMPLATES_DIR, type, name, version)
  const tmplDir = path.join(dir, 'templates')
  await ensureDir(dir)
  await ensureDir(tmplDir)

  const content = yaml.dump(req.body.data, { lineWidth: -1 })
  await fs.writeFile(path.join(dir, 'values.yaml'), content, 'utf-8')

  // Write Helm template file if this type has one (and it doesn't already exist)
  const tmplFilename = HELM_TEMPLATE_FILENAMES[type]
  if (tmplFilename) {
    const tmplFile = path.join(tmplDir, tmplFilename)
    try { await fs.access(tmplFile) } catch {
      await fs.writeFile(tmplFile, HELM_TEMPLATES[type], 'utf-8')
    }
  }

  const chartFile = path.join(dir, 'Chart.yaml')
  try {
    await fs.access(chartFile)
  } catch {
    const chart = {
      apiVersion: 'v2',
      name,
      version: version.replace(/^v/, ''),
      type: 'application'
    }
    await fs.writeFile(chartFile, yaml.dump(chart), 'utf-8')
  }

  res.json({ ok: true })
})

// Delete a specific version
app.delete('/api/templates/:type/:name/:version', async (req, res) => {
  const { type, name, version } = req.params
  const dir = path.join(TEMPLATES_DIR, type, name, version)
  await fs.rm(dir, { recursive: true, force: true })

  // Clean up empty name folder
  const nameDir = path.join(TEMPLATES_DIR, type, name)
  const remaining = await fs.readdir(nameDir).catch(() => [])
  if (remaining.length === 0) {
    await fs.rm(nameDir, { recursive: true, force: true })
  }
  res.json({ ok: true })
})

// ─── Gitops ──────────────────────────────────────────────────────────────────

// Get the product name (first folder under gitops-deploy, if any)
app.get('/api/gitops/product', async (req, res) => {
  try {
    await ensureDir(GITOPS_DIR)
    const entries = await fs.readdir(GITOPS_DIR, { withFileTypes: true })
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name)
    res.json({ name: dirs[0] || null })
  } catch {
    res.json({ name: null })
  }
})

// Rename/set product
app.post('/api/gitops/product', async (req, res) => {
  const { oldName, newName } = req.body
  await ensureDir(GITOPS_DIR)
  if (oldName && oldName !== newName) {
    const src = path.join(GITOPS_DIR, oldName)
    const dst = path.join(GITOPS_DIR, newName)
    await fs.rename(src, dst).catch(() => {})
  } else {
    await ensureDir(path.join(GITOPS_DIR, newName))
  }
  res.json({ ok: true })
})

// List all sites under product → [siteName, ...]
app.get('/api/gitops/:product/sites', async (req, res) => {
  const dir = path.join(GITOPS_DIR, req.params.product)
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    res.json(entries.filter(e => e.isDirectory()).map(e => e.name))
  } catch {
    res.json([])
  }
})

// Create a site
app.post('/api/gitops/:product/sites', async (req, res) => {
  await ensureDir(path.join(GITOPS_DIR, req.params.product, req.body.name))
  res.json({ ok: true })
})

// Delete a site
app.delete('/api/gitops/:product/:site', async (req, res) => {
  const { product, site } = req.params
  await fs.rm(path.join(GITOPS_DIR, product, site), { recursive: true, force: true })
  res.json({ ok: true })
})

// List relunits under site
app.get('/api/gitops/:product/:site/relunits', async (req, res) => {
  const { product, site } = req.params
  const dir = path.join(GITOPS_DIR, product, site)
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    res.json(entries.filter(e => e.isDirectory()).map(e => e.name))
  } catch {
    res.json([])
  }
})

// Create a relunit
app.post('/api/gitops/:product/:site/relunits', async (req, res) => {
  const { product, site } = req.params
  await ensureDir(path.join(GITOPS_DIR, product, site, req.body.name))
  res.json({ ok: true })
})

// Delete a relunit
app.delete('/api/gitops/:product/:site/:relunit', async (req, res) => {
  const { product, site, relunit } = req.params
  await fs.rm(path.join(GITOPS_DIR, product, site, relunit), { recursive: true, force: true })
  res.json({ ok: true })
})

// Get stage values.yaml
app.get('/api/gitops/:product/:site/:relunit/:stage', async (req, res) => {
  const { product, site, relunit, stage } = req.params
  const file = path.join(GITOPS_DIR, product, site, relunit, stage, 'values.yaml')
  try {
    const content = await fs.readFile(file, 'utf-8')
    res.json({ exists: true, parsed: yaml.load(content) })
  } catch {
    res.json({ exists: false, parsed: null })
  }
})

// Save stage values.yaml + optional Chart.yaml (enables the stage)
app.post('/api/gitops/:product/:site/:relunit/:stage', async (req, res) => {
  const { product, site, relunit, stage } = req.params
  const dir = path.join(GITOPS_DIR, product, site, relunit, stage)
  await ensureDir(dir)
  const valContent = yaml.dump(req.body.data, { lineWidth: -1 })
  await fs.writeFile(path.join(dir, 'values.yaml'), valContent, 'utf-8')
  if (req.body.chartData) {
    const chartContent = yaml.dump(req.body.chartData, { lineWidth: -1 })
    await fs.writeFile(path.join(dir, 'Chart.yaml'), chartContent, 'utf-8')
  }
  res.json({ ok: true })
})

// Delete stage (disables the stage)
app.delete('/api/gitops/:product/:site/:relunit/:stage', async (req, res) => {
  const { product, site, relunit, stage } = req.params
  await fs.rm(path.join(GITOPS_DIR, product, site, relunit, stage), { recursive: true, force: true })
  res.json({ ok: true })
})

// ─── System chart metadata (name from Chart.yaml) ────────────────────────────

app.get('/api/templates/system/:name/:version/chartmeta', async (req, res) => {
  const { name, version } = req.params
  const file = path.join(TEMPLATES_DIR, 'system', name, version, 'Chart.yaml')
  try {
    const content = await fs.readFile(file, 'utf-8')
    const chart = yaml.load(content)
    res.json({ name: chart.name, version: chart.version })
  } catch {
    res.status(404).json({ error: 'Chart.yaml not found' })
  }
})

// ─── Helm render ──────────────────────────────────────────────────────────────

function findHelm() {
  return path.join(os.homedir(), 'bin', 'helm')
}

function runCmd(bin, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || stdout || err.message))
      else resolve(stdout)
    })
  })
}

app.post('/api/helm/render/:product/:site/:relunit/:stage', async (req, res) => {
  const { product, site, relunit, stage } = req.params
  const stageDir = path.join(GITOPS_DIR, product, site, relunit, stage)
  const releaseName = `${relunit}-${stage}`.toLowerCase()
  const helm = findHelm()

  const log = []
  try {
    // Read stage Chart.yaml to find the system chart dependency path
    let systemChartDir = null
    try {
      const chartRaw = await fs.readFile(path.join(stageDir, 'Chart.yaml'), 'utf-8')
      const chart = yaml.load(chartRaw)
      const dep = chart.dependencies?.[0]
      if (dep?.repository?.startsWith('file://')) {
        const relPath = dep.repository.replace('file://', '')
        systemChartDir = path.resolve(stageDir, relPath)
      }
    } catch { /* no Chart.yaml yet */ }

    // Step 1: helm dep update on system chart (resolves its alert-suite dependency)
    if (systemChartDir) {
      log.push(`→ helm dependency update (system chart)`)
      const out1 = await runCmd(helm, ['dependency', 'update', systemChartDir], REPO_ROOT)
      log.push(out1.trim())
    }

    // Step 2: helm dep update on the stage chart
    log.push(`→ helm dependency update (stage)`)
    const out2 = await runCmd(helm, ['dependency', 'update'], stageDir)
    log.push(out2.trim())

    // Step 3: helm template
    log.push(`→ helm template ${releaseName} .`)
    const out3 = await runCmd(helm, ['template', releaseName, '.'], stageDir)
    log.push(out3)

    res.json({ ok: true, output: log.join('\n') })
  } catch (err) {
    res.json({ ok: false, output: [...log, err.message].join('\n') })
  }
})

app.listen(3001, () => console.log('API server → http://localhost:3001'))
