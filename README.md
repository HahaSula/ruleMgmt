# Alert Template UI

A local web UI for managing Prometheus Operator alerting templates and Alertmanager configurations. Visually create and version Helm chart–based alert templates, define AM Config routing with optional route pruning, and deploy through a structured GitOps repository layout.

---

## Features

| Editor | What it manages |
|---|---|
| **Alert Type** | Reusable rule skeletons — define `expr` with Go template vars (`{{ .varName }}`), declare parameter names and descriptions |
| **Rule Group** | Compose Alert Types into PrometheusRule groups — fill in var values per rule, set severity, attach group-level labels |
| **Receivers** | Alertmanager receiver configs — supports `webhook`, `email`, `slack`, and `pagerduty`, each with multiple entries per receiver |
| **AM Config** | Full AlertmanagerConfig editor — route matchers, route rules (original or pruned tree), inhibit rules, embedded receivers |
| **Gitops Deploy** | Tree view of `product / site / relunit / stage` — toggle stages on/off, assign an AM Config template, run `helm template` and view rendered YAML inline |
| **PromQL Builder** | Interactive PromQL expression builder with metrics dictionary autocomplete |

All templates are versioned (`v1.0.0`, `v1.0.1`, …) and saved as real Helm charts to the local filesystem.

---

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | 18+ |
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

> The Express API listens on port **3001**. Vite proxies `/api` requests to it automatically.

---

## Repository Layout

```
repo/
├── gitops-deploy/
│   └── {product}/
│       └── {site}/
│           └── {relunit}/
│               └── {stage}/            # DEV | TEST | STG | PROD
│                   ├── Chart.yaml       # Helm wrapper — depends on amconfig chart
│                   └── values.yaml      # Scoped overrides: { chartName: { ... } }
│
├── templates/
│   ├── alert-type/
│   │   └── {name}/{version}/
│   │       ├── Chart.yaml
│   │       ├── values.yaml             # expr template + var declarations
│   │       └── templates/
│   ├── alert-suite/
│   │   └── {name}/{version}/
│   │       ├── Chart.yaml
│   │       ├── values.yaml             # rules + groupLabels
│   │       └── templates/
│   │           └── prometheus-rule.yaml  # PrometheusRule CR
│   ├── receivers/
│   │   └── {name}/{version}/
│   │       ├── Chart.yaml
│   │       └── values.yaml             # Alertmanager receivers block
│   └── amconfig/
│       └── {name}/{version}/
│           ├── Chart.yaml              # depends on alert-suite charts
│           ├── values.yaml             # routes, matchers, inhibitRules, receivers
│           └── templates/
│               └── alertmanager-config.yaml  # AlertmanagerConfig CR
│
├── scripts/
│   └── prune_routes.py                 # Standalone CLI for route tree pruning
│
├── config/
│   └── defaults.yaml
│
└── src/                                # React + Express source
```

---

## Helm Chart Architecture

Each GitOps stage is a Helm chart with a `file://` dependency on the chosen AM Config template. The AM Config chart in turn depends on one or more alert-suite charts:

```
gitops-deploy/.../PROD/  →  templates/amconfig/{name}/{version}/  →  templates/alert-suite/{name}/{version}/
```

Running `helm template` on a stage renders both the **PrometheusRule** and **AlertmanagerConfig** CRs.

### Render a stage manually

```bash
# 1. Resolve amconfig chart's sub-dependencies (alert-suite charts)
helm dependency update templates/amconfig/{name}/{version}/

# 2. Resolve the stage chart's dependency (amconfig)
cd gitops-deploy/{product}/{site}/{relunit}/{stage}
helm dependency update

# 3. Render
helm template {relunit}-{stage} .
```

> Release names must be lowercase — the UI and server enforce this automatically.

### File path formula

The `file://` repository path in a stage's `Chart.yaml` is always **5 levels up** from the stage folder to the repo root:

```yaml
repository: "file://../../../../../templates/amconfig/{name}/{version}"
```

---

## Template Data Formats

### Alert Type (`values.yaml`)

```yaml
name: high-threshold
description: "Metric threshold alert"
expr: "{{ .metric }} {{ .op }} {{ .threshold }}"
vars:
  - name: metric
    description: "PromQL metric expression"
  - name: op
    description: "Comparison operator (>, <, >=, <=)"
  - name: threshold
    description: "Threshold value"
for: "5m"
labels: {}
```

### Rule Group / Alert Suite (`values.yaml`)

```yaml
alertSuite:
  name: platform-infra
  groupLabels:
    team: platform
  rules:
    - alertTypeName: high-threshold
      alertTypeVersion: v1.0.0
      ruleName: high-cpu
      expr: "cpu_usage > 80"
      vars:
        metric: cpu_usage
        op: ">"
        threshold: "80"
      severity: warning
      for: "5m"
      description: "CPU above 80% on {{ $labels.instance }}"
      labels:
        team: platform
```

### AM Config (`values.yaml`)

```yaml
configName: platform-routing
defaultReceiver: slack-warnings
groups:
  - name: platform-infra
    version: v1.0.0
routeMatchers:                         # spec.route.matchers — namespace filter
  - key: namespace
    op: "="
    value: production
routeMode: original                    # original | pruned
routeRules:
  - receiver: pagerduty-critical
    matchers:
      - key: severity
        op: "="
        value: critical
  - receiver: slack-warnings
    matchers:
      - key: severity
        op: "="
        value: warning
inhibitRules:
  - sourceMatchers:
      - key: severity
        op: "="
        value: critical
    targetMatchers:
      - key: severity
        op: "="
        value: warning
    equal:
      - alertname
receivers:
  - name: pagerduty-critical
    pagerduty_configs:
      - routing_key: YOUR_KEY
        send_resolved: true
  - name: slack-warnings
    slack_configs:
      - api_url: https://hooks.slack.com/...
        channel: "#alerts"
        send_resolved: true
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

---

## Route Pruning

The AM Config editor supports two route display modes:

- **Original** — routes exactly as entered, flat list
- **Pruned** — routes synthesized into a trie tree, hoisting shared matchers into parent nodes

Pruning is computed server-side via `POST /api/prune-routes`. A standalone CLI version is available for manual use:

```bash
# From JSON/YAML file
python3 scripts/prune_routes.py input.yaml

# From stdin
echo '{"routeRules":[...], "routeMatchers":[...]}' | python3 scripts/prune_routes.py
```

The pruned route tree is stored in `values.yaml` when saved in pruned mode.

---

## Development

```bash
# Frontend only (Vite dev server on :5173)
npx vite

# Backend only (Express API on :3001)
node server.js

# Production build
npm run build
```

### Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, plain CSS, Vite 5 |
| Backend | Express (ES modules), js-yaml |
| Editor | CodeMirror 6 with PromQL language support |
| Helm | v3, `file://` local chart dependencies |

---

## Notes

- Template names and folder names are free-form strings.
- Version format is `v{major}.{minor}.{patch}` (e.g. `v1.0.0`). The `v` prefix is stripped when used in Helm `dependencies[].version`.
- Stage folders (`DEV`, `TEST`, `STG`, `PROD`) are fixed — toggling a stage "on" creates the folder; toggling "off" removes it.
- The `values.yaml` in a GitOps stage scopes all overrides under the dependency chart name key (e.g. `platform-routing: { ... }`). An empty override must be `{}`, not `null`, to avoid Helm type errors.
- The `global.product` value is injected by the GitOps stage and prefixes all Kubernetes resource names to avoid collisions across products.
