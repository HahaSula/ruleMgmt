## 任務說明

Generate Helm chart files for two Prometheus Operator CRs:
1. PrometheusRule — under alert-suite template
2. AlertmanagerConfig — under system template

Both CRs are rendered via `helm template` for local testing.
No namespace in metadata. Managed by Helm label only.

---

## 目標檔案結構

templates/
├── alert-suite/
│   └── {name}/
│       └── {version}/
│           ├── Chart.yaml
│           ├── values.yaml          # alertSuite + receivers block
│           └── templates/
│               └── prometheus-rule.yaml   # PrometheusRule CR
│
└── system/
    └── {name}/
        └── {version}/
            ├── Chart.yaml
            ├── values.yaml          # system + receivers + alertSuite.inhibit block
            └── templates/
                └── alertmanager-config.yaml  # AlertmanagerConfig CR

---

## Chart.yaml

apiVersion: v2
name: <chart-name>         # e.g. platform-suite or platform-system
description: <description>
type: application
version: <semver>           # e.g. 1.0.0
appVersion: <semver>

---

## values.yaml — alert-suite

alertSuite:
  name: "platform-suite"
  groupLabel: "team: platform"

  rules:
    - ruleName: "high-cpu"
      expr: "rate(cpu_usage[5m]) > 0.9"
      for: "10m"
      description: "CPU usage too high"
      labels:
        env: production
      severity: critical

    - ruleName: "high-mem"
      expr: "rate(mem_usage[5m]) > 0.85"
      for: "5m"
      description: "Memory usage too high"
      labels:
        env: production
      severity: warning

  inhibit:
    - sourceRule: "high-cpu"
      targetRule: "high-mem"

---

## templates/prometheus-rule.yaml

apiVersion: monitoring.coreos.com/v1
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

---

## values.yaml — system

system:
  alertSuiteName: "platform-suite"
  groupLabel: "team: platform"
  routes:
    - severity: critical
      receiver: "platform-receiver"
    - severity: warning
      receiver: "platform-receiver"

receivers:
  - name: "platform-receiver"
    webhook_configs:
      - url: "https://hook1.example.com"
        send_resolved: true
    email_configs:
      - to: "team@example.com"
        from: "alertmanager@example.com"
        smarthost: "smtp.example.com:587"
    slack_configs:
      - api_url: "https://hooks.slack.com/..."
        channel: "#alerts"
    pagerduty_configs:
      - routing_key: "..."

alertSuite:
  inhibit:
    - sourceRule: "high-cpu"
      targetRule: "high-mem"

---

## templates/alertmanager-config.yaml

apiVersion: monitoring.coreos.com/v1alpha1
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
    receiver: {{ (index .Values.system.routes 0).receiver | quote }}
    routes:
      {{- range .Values.system.routes }}
      - matchers:
          - name: severity
            value: {{ .severity | quote }}
        receiver: {{ .receiver | quote }}
      {{- end }}

  receivers:
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

---

## 測試指令

# Render PrometheusRule
helm template test ./templates/alert-suite/platform-suite/v1.0.0 \
  --show-only templates/prometheus-rule.yaml

# Render AlertmanagerConfig
helm template test ./templates/system/platform-system/v1.0.0 \
  --show-only templates/alertmanager-config.yaml

# 帶入 gitops deploy values 覆蓋測試
helm template test ./templates/system/platform-system/v1.0.0 \
  -f ./gitops-deploy/my-product/site-a/unit-1/PROD/values.yaml \
  --show-only templates/alertmanager-config.yaml

---

## Claude Code 執行指令

claude "Create Helm chart files for Prometheus Operator CRs as described in HELM_SPEC.md.

Tasks:
1. Create alert-suite Helm chart:
   - Chart.yaml
   - values.yaml (alertSuite block: name, groupLabel, rules list, inhibit list)
   - templates/prometheus-rule.yaml
     - kind: PrometheusRule (monitoring.coreos.com/v1)
     - metadata.name: from .Values.alertSuite.name
     - no namespace in metadata
     - spec.groups[].name: from .Values.alertSuite.name
     - loop rules: alert, expr, for (optional), labels (severity + extra), annotations (description, summary)

2. Create system Helm chart:
   - Chart.yaml
   - values.yaml (system block, receivers list, alertSuite.inhibit list)
   - templates/alertmanager-config.yaml
     - kind: AlertmanagerConfig (monitoring.coreos.com/v1alpha1)
     - metadata.name: from .Values.system.alertSuiteName
     - no namespace in metadata
     - spec.route: groupBy from system.groupLabel, loop routes as matchers by severity
     - spec.receivers: loop receivers, each supports webhook_configs / email_configs /
       slack_configs / pagerduty_configs as sub-lists
       use Prometheus Operator camelCase field names:
         webhookConfigs, emailConfigs, slackConfigs, pagerdutyConfigs
         sendResolved, apiURL, routingKey, requireTLS, smarthost
     - spec.inhibitRules: from .Values.alertSuite.inhibit
       sourceMatch/targetMatch by alertname, equal: [namespace]

3. After generating files, run:
   helm template test ./templates/alert-suite/platform-suite/v1.0.0 \
     --show-only templates/prometheus-rule.yaml
   helm template test ./templates/system/platform-system/v1.0.0 \
     --show-only templates/alertmanager-config.yaml
   Fix any rendering errors until both commands succeed."