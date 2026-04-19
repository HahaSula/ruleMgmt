## 專案目標

Build a local UI tool (React or plain HTML/JS) for managing a Prometheus alerting template system. The tool should allow users to visually create and edit Helm chart-based alert templates, and manage a Gitops deploy repository structure.

---

## Repo 結構

repo/
├── gitops-deploy/
│   └── {product-name}/           # single, user-defined string
│       └── {site-name}/          # user-defined, CRUD
│           └── {relunit-name}/   # user-defined, CRUD
│               └── {stage-name}/ # fixed: DEV | TEST | STG | PROD
│                   └── values.yaml
│
├── templates/
│   ├── alert-type/
│   │   └── {name}/               # user-defined template name, CRUD
│   │       └── {version}/        # semver e.g. v1.0.0, no conflict with old
│   │           ├── Chart.yaml
│   │           ├── templates/
│   │           └── values.yaml
│   ├── alert-suite/
│   │   └── {name}/
│   │       └── {version}/
│   │           ├── Chart.yaml
│   │           ├── templates/
│   │           └── values.yaml
│   ├── receivers/
│   │   └── {name}/
│   │       └── {version}/
│   │           ├── Chart.yaml
│   │           ├── templates/
│   │           └── values.yaml
│   ├── system/
│   │   └── {name}/
│   │       └── {version}/
│   │           ├── Chart.yaml
│   │           ├── templates/
│   │           └── values.yaml
│   └── inhibit/                  # sub-object inside alert-suite
│       └── {name}/
│           └── {version}/
│               ├── Chart.yaml
│               ├── templates/
│               └── values.yaml
│
├── config/
│   └── defaults.yaml
│
└── src/                          # JS source — local UI/UX app

---

## Alert Type Template

# values.yaml schema — input is a LIST of alert type definitions

alertTypes:
  - name: "high_cpu"           # required — exposed externally
    rule:
      expr: "{{ .metrics }} {{ .op }} {{ .constant }}"  # required
      vars:                    # free-form internal vars, user-defined count
        metrics: "rate(cpu_usage[5m])"
        op: ">"
        constant: 0.9
    description: ""            # optional
    for: "5m"                  # optional
    labels: {}                 # optional

# Rule: internal vars scope is limited to the single rule they belong to.
# Exposed to outside: name + rendered expr (vars substituted).

---

## Alert Suite Template

# Alert Suite = multiple Alert Type rules + inhibit sub-object

alertSuite:
  groupLabel: "team: platform"   # dispatched to System

  rules:
    - alertTypeName: "high_cpu"  # reference existing Alert Type name
      for: "10m"                 # supplement / override
      description: "CPU too high"
      labels:
        env: production
      severity: critical         # per-rule severity

    - alertTypeName: "high_mem"
      severity: warning

  inhibit:                       # sub-object of Alert Suite
    - sourceRule: "high_cpu"     # select from defined rule names in this suite
      targetRule: "high_mem"

---

## Receivers Template

# Follows Alertmanager receivers format exactly
receivers:
  - name: "slack-critical"
    slack_configs:
      - api_url: "https://hooks.slack.com/..."
        channel: "#alerts-critical"

  - name: "pagerduty-warning"
    pagerduty_configs:
      - routing_key: "..."

---

## System Template

# System selects Alert Suite and maps severity → receivers
system:
  alertSuite: "platform-suite"   # reference Alert Suite template name
  groupLabel: "team: platform"   # fill in dispatch label

  routes:
    - severity: critical
      receiver: "slack-critical"
    - severity: warning
      receiver: "pagerduty-warning"

---

## UI 功能需求

The local UI (React or plain HTML/JS) must support:

1. Alert Type Editor
   - List all alert-type templates (grouped by name, with version list)
   - Form: name, expr, free-form internal vars (add/remove key-value rows)
   - Preview: rendered expr with vars substituted
   - Version management: create new version under same name

2. Alert Suite Editor
   - Select alert types by name+version from existing list
   - Per-rule supplement fields: for, description, labels, severity
   - Inhibit sub-editor: pick sourceRule + targetRule from suite's rule names
   - Group label input
   - Version management: create new version under same name

3. Receivers Editor
   - Follow Alertmanager receiver YAML structure
   - Support: slack, pagerduty, email, webhook (at minimum)
   - Version management: create new version under same name

4. System Editor
   - Select Alert Suite by name+version (dropdown)
   - Fill group label
   - Severity → Receiver mapping table (add/remove rows)
   - Version management: create new version under same name

5. Gitops Deploy Repo Editor
   - Tree view: product / site / relunit / stage structure
   - product-name: single string input (only one allowed)
   - site-name: CRUD under product
   - relunit-name: CRUD under each site
   - stage-name: fixed options DEV | TEST | STG | PROD (toggle on/off per relunit)
   - Each stage: pick System template (name + version) + fill deploy values
   - Output: generate values.yaml at correct path

6. General
   - All template names and folder names are user-defined strings
   - Version format: v{semver} e.g. v1.0.0
   - Export: render final YAML files to local filesystem
   - Import: load existing YAML from repo folder structure

---

## Claude Code 執行指令

claude "Build the local alert template management UI described in SPEC.md.
Use React with plain CSS (no UI framework needed).
Start with:
1. Project scaffold (Vite + React)
2. YAML read/write utility (js-yaml)
3. Alert Type Editor page with dynamic variable rows and version support
4. Navigation between all editors
Follow the repo folder structure in SPEC.md exactly.
Template structure: templates/{type}/{name}/{version}/
Gitops structure: gitops-deploy/{product}/{site}/{relunit}/{stage}/values.yaml
Stage values are fixed: DEV, TEST, STG, PROD."