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
│   │       └── {version}/        # semver e.g. v1.0.0
│   │           ├── Chart.yaml
│   │           ├── templates/
│   │           └── values.yaml
│   ├── alert-suite/
│   │   └── {name}/
│   │       └── {version}/
│   ├── receivers/
│   │   └── {name}/
│   │       └── {version}/
│   ├── system/
│   │   └── {name}/
│   │       └── {version}/
│   └── inhibit/
│       └── {name}/
│           └── {version}/
│
├── config/
│   └── defaults.yaml
│
└── src/                          # JS source — local UI/UX app

---

## Alert Type Template

# Alert Type defines a REUSABLE rule skeleton.
# vars declares the parameter names exposed to Alert Suite.
# Alert Suite is responsible for filling in the actual values.

# Example: "single-threshold" — a generic threshold rule skeleton
name: single-threshold
description: "A single metric threshold rule"   # optional
expr: "{{ .metrics }} {{ .op }} {{ .constant }}"
vars:                  # declare parameters (names only, no default values required)
  - name: metrics
    description: "PromQL metric expression"
  - name: op
    description: "Comparison operator: >, <, >=, <="
  - name: constant
    description: "Threshold value"
for: ""                # optional default, can be overridden in Alert Suite
labels: {}             # optional default labels

# Rule:
# - vars is a LIST of parameter declarations (name + optional description)
# - var count is free-form, user can add/remove rows in UI
# - expr uses Go template syntax {{ .varName }} to reference vars
# - Alert Suite fills in actual values for each var when using this Alert Type

---

## Alert Suite Template

# Alert Suite references Alert Types and fills in their var values.

alertSuite:
  name: "platform-suite"
  groupLabel: "team: platform"   # dispatched to System

  rules:
    - alertTypeName: "single-threshold"   # reference Alert Type name
      alertTypeVersion: "v1.0.0"
      ruleName: "high-cpu"               # instance name for this rule
      vars:                              # fill in Alert Type's declared vars
        metrics: "rate(cpu_usage[5m])"
        op: ">"
        constant: 0.9
      for: "10m"                         # supplement / override Alert Type default
      description: "CPU usage too high"
      labels:
        env: production
      severity: critical

    - alertTypeName: "single-threshold"
      alertTypeVersion: "v1.0.0"
      ruleName: "high-mem"
      vars:
        metrics: "rate(mem_usage[5m])"
        op: ">"
        constant: 0.85
      severity: warning

  inhibit:                               # sub-object of Alert Suite
    - sourceRule: "high-cpu"             # select from ruleName list in this suite
      targetRule: "high-mem"

---

## Receivers Template

# Follows Alertmanager receivers format exactly.
# One receiver can contain multiple configs of each type.

receivers:
  - name: "platform-receiver"
    webhook_configs:                     # multiple webhooks allowed
      - url: "https://hook1.example.com"
        send_resolved: true
      - url: "https://hook2.example.com"
        send_resolved: false
    email_configs:                       # multiple emails allowed
      - to: "team-a@example.com"
        from: "alertmanager@example.com"
        smarthost: "smtp.example.com:587"
      - to: "team-b@example.com"
        from: "alertmanager@example.com"
        smarthost: "smtp.example.com:587"
    slack_configs:                       # multiple slack configs allowed
      - api_url: "https://hooks.slack.com/..."
        channel: "#alerts-critical"
    pagerduty_configs:                   # multiple pagerduty configs allowed
      - routing_key: "..."

# UI rule: each config type (webhook, email, slack, pagerduty) renders as
# a sub-list with add/remove row support within the same receiver card.

---

## System Template

# System selects Alert Suite and maps severity → receivers
system:
  alertSuite: "platform-suite"     # reference Alert Suite template name
  alertSuiteVersion: "v1.0.0"
  groupLabel: "team: platform"     # fill in dispatch label

  routes:
    - severity: critical
      receiver: "platform-receiver"
    - severity: warning
      receiver: "platform-receiver"

---

## UI 功能需求

The local UI (React or plain HTML/JS) must support:

1. Alert Type Editor
   - List all alert-type templates grouped by name, with version selector
   - Form fields: name, description (optional), expr, for (optional), labels (optional)
   - Vars editor: add/remove rows, each row has: name + description
   - expr preview: show rendered output with placeholder values substituted
   - Version management: create new version under same name

2. Alert Suite Editor
   - List all alert-suite templates grouped by name, with version selector
   - Rules editor: add/remove rules, each rule has:
       - alertTypeName + alertTypeVersion (dropdown from existing alert types)
       - ruleName (user string, used for inhibit reference)
       - vars: key-value form auto-generated from selected Alert Type's declared vars
       - for, description, labels, severity fields
   - Inhibit sub-editor: add/remove rows, each row picks sourceRule + targetRule
     from the ruleName list defined in this suite (dropdown)
   - groupLabel input
   - Version management: create new version under same name

3. Receivers Editor
   - List all receiver templates grouped by name, with version selector
   - One receiver card contains multiple config type sections:
       - webhook_configs: list of webhook entries (add/remove), fields: url, send_resolved
       - email_configs: list of email entries (add/remove), fields: to, from, smarthost
       - slack_configs: list of slack entries (add/remove), fields: api_url, channel
       - pagerduty_configs: list of pagerduty entries (add/remove), fields: routing_key
   - Each config type section is collapsible, add/remove entries independently
   - Version management: create new version under same name

4. System Editor
   - Select Alert Suite by name+version (dropdown)
   - Fill groupLabel
   - Severity → Receiver mapping table (add/remove rows)
     - severity: free string or enum (critical/warning/info)
     - receiver: dropdown from existing receiver template names
   - Version management: create new version under same name

5. Gitops Deploy Repo Editor
   - Tree view: product / site / relunit / stage
   - product-name: single string input (only one allowed globally)
   - site-name: CRUD under product
   - relunit-name: CRUD under each site
   - stage-name: fixed options DEV | TEST | STG | PROD (toggle per relunit)
   - Each stage: pick System template (name + version) + fill deploy override values
   - Output: generate values.yaml at correct path

6. General
   - All template names are user-defined strings
   - Version format: v{semver} e.g. v1.0.0
   - Export: render final YAML files to local filesystem
   - Import: load existing YAML from repo folder structure

---

## Claude Code 執行指令

claude "Build the local alert template management UI described in spec/SPEC2.md.
Use React with plain CSS (no UI framework needed).
Start with:
1. Project scaffold (Vite + React)
2. YAML read/write utility (js-yaml)
3. Alert Type Editor:
   - vars is a LIST of parameter declarations (name + description)
   - expr uses Go template syntax {{ .varName }}
   - Alert Suite fills in actual var values when referencing an Alert Type
4. Receivers Editor:
   - one receiver contains multiple config sections (webhook, email, slack, pagerduty)
   - each section is a list with add/remove row support
   - output must match Alertmanager receivers YAML format exactly
5. Navigation between all editors

Folder structure rules:
- templates/{type}/{name}/{version}/
- gitops-deploy/{product}/{site}/{relunit}/{stage}/values.yaml
- stage is fixed enum: DEV | TEST | STG | PROD"