# Agent Status Log

## Project: Alert Template UI
React 18 + Express (port 3001) + Vite (port 5173). Manages Prometheus Operator alert templates as Helm charts in a GitOps repo structure.

## Stack
- Frontend: React 18, plain CSS, Vite
- Backend: Express, js-yaml, execFile for helm
- Helm: ~/bin/helm (v3.14.4 on Windows, installed manually)

## Key Directories
- `templates/alert-type/`, `templates/alert-suite/`, `templates/receivers/`, `templates/system/`
- `gitops-deploy/{product}/{site}/{relunit}/{stage}/` — each stage has Chart.yaml + values.yaml

## Helm Architecture
GitOps stage → system chart (via `file://`) → alert-suite chart (via `file://`)
- PrometheusRule rendered from alert-suite
- AlertmanagerConfig rendered from system
- Stage values.yaml MUST be `{ chartName: {} }` not `null` (Helm type mismatch otherwise)

## Fixes Applied (session 2026-04-26)

### Bug 1 — Missing PrometheusRule in helm render output
- `templates/alert-suite/platform-suite/v1.0.1/templates/prometheus-rule.yaml` — created (was missing)
- `templates/alert-suite/platform-suite/v1.0.2/templates/prometheus-rule.yaml` — created (was missing)
- `templates/system/system-1776617684668/v1.0.{0,1,2}/Chart.yaml` — added alert-suite `dependencies` block
- `server.js` `POST /api/templates/system/:name/:version` — now always writes/updates Chart.yaml with alert-suite dep extracted from `req.body.data.system.alertSuite` + `.alertSuiteVersion`

### Bug 2 — GitOps page doesn't restore system state on reload
- `server.js` `GET /api/gitops/:product/:site/:relunit/:stage` — now returns `{ exists, parsed, chart: { exists, parsed } }` (added Chart.yaml read)
- `GitopsEditor.jsx` `selectStage()` — now parses `chart.parsed.dependencies[0].repository` with regex `/templates\/system\/([^/]+)\/([^/]+)$/` to restore `systemName`, `systemVersion`, `chartName`, `chartSemver`

### Bug 3 — Alert Suite var value inputs too small
- `AlertSuiteEditor.jsx` var value `<input>` → `<textarea rows=1>` with `onInput` auto-resize (`scrollHeight`)

## Known Working State
- `gitops-deploy/my-product/site-a/unit-1/PROD/` — demo stage with `platform-system` dep, renders both CRs
- `gitops-deploy/hehehe/RDSMA/mairadb/TEST/values.yaml` — fixed from `null` to `{}`

## Critical Implementation Notes
- System chart Chart.yaml `dependencies[].repository` uses relative path `file://../../../alert-suite/{name}/{version}`
- Stage chart Chart.yaml `dependencies[].repository` uses `file://../../../../../templates/system/{name}/{version}` (5 levels up)
- Helm release name must be lowercase: `${relunit}-${stage}.toLowerCase()`
- Version in Helm fields strips `v` prefix: `v1.0.0` → `1.0.0`
- `buildStageValues()` must return `{ chartName: {} }` not `{ chartName: null }` to avoid type mismatch

## Server Endpoints Reference
- `GET  /api/templates/:type` → `{ [name]: [version] }`
- `GET  /api/templates/:type/:name/:version` → `{ content, parsed }`
- `POST /api/templates/:type/:name/:version` → writes values.yaml + Chart.yaml (with dep for system) + helm template file
- `GET  /api/gitops/:product/:site/:relunit/:stage` → `{ exists, parsed, chart: { exists, parsed } }`
- `POST /api/gitops/:product/:site/:relunit/:stage` → `{ data, chartData }`
- `GET  /api/templates/system/:name/:version/chartmeta` → `{ name, version }`
- `POST /api/helm/render/:product/:site/:relunit/:stage` → `{ ok, output }`
