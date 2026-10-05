{{- define "hearth.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}{{ .Release.Name | trunc 50 | trimSuffix "-" }}{{- else -}}{{ printf "%s-%s" .Release.Name .Chart.Name | trunc 50 | trimSuffix "-" }}{{- end -}}
{{- end -}}

{{- define "hearth.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Values.image.tag | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* Selector for one component: (dict "ctx" $ "component" "api") */}}
{{- define "hearth.selector" -}}
app.kubernetes.io/name: {{ .ctx.Chart.Name }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "hearth.tag" -}}
{{- $tag := required "image.tag is required (a commit tag such as sha-1234abc)" .Values.image.tag -}}
{{- if has $tag (list "main" "latest") -}}{{ fail (printf "image.tag %q floats; use a commit tag (sha-<short>)" $tag) }}{{- end -}}
{{- $tag -}}
{{- end -}}

{{- define "hearth.serverImage" -}}{{ .Values.image.server.repository }}:{{ include "hearth.tag" . }}{{- end -}}
{{- define "hearth.webImage" -}}{{ .Values.image.web.repository }}:{{ include "hearth.tag" . }}{{- end -}}

{{- define "hearth.tokenSecret" -}}
{{- required "gateway.tokenSecret.name is required (a Secret holding the gateway's bearer token)" .Values.gateway.tokenSecret.name -}}
{{- end -}}

{{/* nodeSelector + tolerations for the pods that need the Ollama/data node. */}}
{{- define "hearth.placement" -}}
{{- with .Values.placement.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.placement.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/* The data volume: a host folder or a PVC the user owns (never created by the chart). */}}
{{- define "hearth.dataVolume" -}}
{{- $p := .Values.persistence -}}
{{- if and $p.hostPath $p.existingClaim -}}{{ fail "set only one of persistence.hostPath and persistence.existingClaim" }}{{- end -}}
- name: data
{{- if $p.hostPath }}
  hostPath:
    path: {{ $p.hostPath }}
    type: Directory
{{- else if $p.existingClaim }}
  persistentVolumeClaim:
    claimName: {{ $p.existingClaim }}
{{- else }}
{{- fail "set persistence.hostPath or persistence.existingClaim: the chart never creates the database volume, so uninstalling can't delete it" }}
{{- end }}
{{- end -}}

{{- define "hearth.containerSecurity" -}}
allowPrivilegeEscalation: false
capabilities:
  drop: [ALL]
{{- end -}}

{{/* Env shared by everything that talks to the gateway. */}}
{{- define "hearth.gatewayClientEnv" -}}
- name: HEARTH_GATEWAY_URL
  value: http://{{ include "hearth.fullname" . }}-gateway:{{ .Values.gateway.port }}
- name: HEARTH_GATEWAY_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ include "hearth.tokenSecret" . }}
      key: {{ .Values.gateway.tokenSecret.key }}
{{- end -}}

{{/* TZ for every hearth container, when a time zone is set. */}}
{{- define "hearth.tzEnv" -}}
{{- with .Values.timezone }}
- name: TZ
  value: {{ . | quote }}
{{- end }}
{{- end -}}
