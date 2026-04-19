# Alert Template UI

A local web UI for managing Prometheus Operator alerting templates and GitOps deploy configurations. Visually create and version Helm chart–based alert templates, then render and deploy them through a structured GitOps repository layout.

---

## Features

| Editor | What it manages |
|---|---|
| **Alert Type** | Reusable rule skeletons — define `expr` with Go template vars (`{{ .varName }}`), declare parameter names and descriptions |
| **Alert Suite** | Compose Alert Types into rule groups — fill in var values per rule, set severity, add inhibit rules |
| **Receivers** | Alertmanager receiver configs — supports `webhook`, `email`, `slack`, and `pagerduty`, each with multiple entries per receiver |
| **System** | Wire an Alert Suite to receivers via severity → receiver routing |
| **GitOps Deploy** | Tree view of `product / site / relunit / stage` — toggle stages on/off, assign a System template, run `helm template` and view rendered YAML inline |

All templates are versioned (`v1.0.0`, `v1.0.1`, …) and saved as real Helm charts to the local filesystem.

---

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | 18 + |
| Helm | 3.x |

---

## Getting Started

```bash
# 1. Install dependencies
npm install

# 2. Start the dev server (Express API + Vite frontend run concurrently)
npm run dev
```

Open **http://localhost:5173** in your browser.

> The Express API listens on port **3001** and Vite proxies `/api` requests to it automatically.

---

## Repository Layout

```
repo/
├── gitops-deploy/
│   └── {product}/
│       └── {site}/
│           └── {relunit}/
│               └── {stage}/          # DEV | TEST | STG | PROD
│                   ├── Chart.yaml    # Helm wrapper — depends on system chart
│                   └── values.yaml   # Scoped overrides: { chartName: { ... } }
│
├── templates/
│   ├── alert-type/
│   │   └── {name}/{version}/
│   │       ├── Chart.yaml
│   │       ├── values.yaml           # alert type definition + var declarations
│   │       └── templates/
│   ├── alert-suite/
│   │   └── {name}/{version}/
│   │       ├── Chart.yaml
│   │       ├── values.yaml           # rules + inhibit
│   │       └── templates/
│   │           └── prometheus-rule.yaml   # PrometheusRule CR
│   ├── receivers/
│   │   └── {name}/{version}/
│   │       ├── Chart.yaml
│   │       └── values.yaml           # Alertmanager receivers block
│   └── system/
│       └── {name}/{version}/
│           ├── Chart.yaml            # depends on alert-suite chart
│           ├── values.yaml           # system routes + receivers
│           └── templates/
│               └── alertmanager-config.yaml  # AlertmanagerConfig CR
│
├── config/
│   └── defaults.yaml
│
└── src/                              # React + Express source
```

---

## Helm Chart Architecture

Each GitOps stage folder is itself a Helm chart with a `file://` dependency on the chosen System template:

```
gitops-deploy/.../PROD/  →  templates/system/{name}/{version}/  →  templates/alert-suite/{name}/{version}/
```

Running `helm template` on a stage renders both the **PrometheusRule** and **AlertmanagerConfig** CRs.

### Render a stage manually

```bash
# 1. Resolve system chart's sub-dependency (alert-suite)
helm dependency update templates/system/{name}/{version}/

# 2. Resolve the stage chart's dependency (system)
cd gitops-deploy/{product}/{site}/{relunit}/{stage}
helm dependency update

# 3. Render
helm template {relunit}-{stage} .
```

> Release names must be lowercase — the UI and server enforce this automatically.

### File path formula

The `file://` repository path in a stage's `Chart.yaml` is always **5 levels up** from the stage folder to the repo root:

```yaml
repository: "file://../../../../../templates/system/{name}/{version}"
```

---

## Template Data Formats

### Alert Type (`values.yaml`)

```yaml
name: single-threshold
description: "A single metric threshold rule"
expr: "{{ .metrics }} {{ .op }} {{ .constant }}"
vars:
  - name: metrics
    description: "PromQL metric expression"
  - name: op
    description: "Comparison operator"
  - name: constant
    description: "Threshold value"
for: "5m"
labels: {}
```

### Alert Suite (`values.yaml`)

```yaml
alertSuite:
  name: platform-suite
  groupLabel: "team: platform"
  rules:
    - alertTypeName: single-threshold
      alertTypeVersion: v1.0.0
      ruleName: high-cpu
      vars:
        metrics: "rate(cpu_usage[5m])"
        op: ">"
        constant: 0.9
      severity: critical
      for: "10m"
  inhibit:
    - sourceRule: high-cpu
      targetRule: high-mem
```

### Receivers (`values.yaml`)

```yaml
receivers:
  - name: platform-receiver
    webhook_configs:
      - url: "https://hook.example.com"
        send_resolved: true
    slack_configs:
      - api_url: "https://hooks.slack.com/..."
        channel: "#alerts"
    pagerduty_configs:
      - routing_key: "..."
    email_configs:
      - to: "team@example.com"
        from: "alertmanager@example.com"
        smarthost: "smtp.example.com:587"
```

### System (`values.yaml`)

```yaml
system:
  alertSuite: platform-suite
  alertSuiteVersion: v1.0.0
  groupLabel: "team: platform"
  routes:
    - severity: critical
      receiver: platform-receiver
    - severity: warning
      receiver: platform-receiver
```

---

## Development

```bash
# Frontend only (Vite)
npx vite

# Backend only (Express API on :3001)
node server.js

# Production build
npm run build
```

### Stack

- **Frontend** — React 18, plain CSS (no UI framework), Vite
- **Backend** — Express (file system API, Helm runner)
- **YAML** — js-yaml (server-side parse/dump)
- **Helm** — v3, `file://` local chart dependencies

---

## Notes

- All template names and folder names are free-form user strings.
- Version format is `v{major}.{minor}.{patch}` (e.g. `v1.0.0`). The `v` prefix is stripped when used in Helm `dependencies[].version`.
- Stage folders (`DEV`, `TEST`, `STG`, `PROD`) are fixed — toggling a stage "on" creates the folder; toggling "off" removes it.
- The `values.yaml` in a GitOps stage scopes all overrides under the dependency chart name key (e.g. `platform-system: { ... }`). An empty override must be `{}`, not `null`, to avoid Helm type errors.
