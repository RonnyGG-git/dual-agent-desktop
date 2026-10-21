# Arquitectura — Dual Agent Desktop

## Visión general

```
┌──────────────────────── Renderer (React, sandbox, sin Node) ────────────────────────┐
│ InstructionBar · AgentPanel ×2 · StageLights · ActivityFeed · Historial · Ajustes   │
└───────────────▲──────────────────────────────────────────────┬──────────────────────┘
                │ dad:snapshot (push, agrupado cada 80 ms)      │ invoke: submit/cancel/…
┌───────────────┴────────────── preload (contextBridge) ───────▼──────────────────────┐
└───────────────▲──────────────────────────────────────────────┬──────────────────────┘
┌───────────────┴──────────────── Proceso principal ───────────▼──────────────────────┐
│ AppController ── estado de agentes, comprobaciones de arranque, IPC                 │
│   └─ Orchestrator (única autoridad del estado de la tarea)                          │
│        ├─ ClaudeAdapter ──── claude.exe -p --output-format stream-json …            │
│        │     └─ guard-hook.cjs (PreToolUse, inyectado con --settings)               │
│        ├─ OpenCodeAdapter ── opencode.exe run --format json --agent dadqa …         │
│        ├─ test-runner ────── npm test / mvn test / gradlew test / pytest …          │
│        ├─ git (snapshots) ── git status -z -uall + recorrido de rutas escribibles   │
│        ├─ WriteLock ──────── bloqueo de escritura del workspace                     │
│        └─ HistoryStore ───── %LOCALAPPDATA%\DualAgentDesktop\tasks\*.json           │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

| Carpeta | Contenido |
|---|---|
| `electron/main` | Ciclo de vida de la ventana, IPC, `AppController` |
| `electron/preload` | API mínima `window.dad` (contextIsolation + sandbox) |
| `electron/adapters` | `ClaudeAdapter`, `OpenCodeAdapter`, clasificación de errores |
| `electron/orchestrator` | Máquina de estados de la tarea y prompts de cada etapa |
| `electron/security` | Hook guardián, política por tarea, bloqueo de escritura |
| `electron/services` | Procesos, ejecutables, git, pruebas, configuración, historial |
| `shared` | Tipos y esquemas zod compartidos entre proceso principal e interfaz |
| `src` | Interfaz React |
| `tests` | `unit/`, `integration/` (CLIs simuladas y reales), `ui/` |

## Flujo de una tarea

| Etapa (foco) | Quién | Cómo | Salida validada |
|---|---|---|---|
| REVISANDO | Claude | `--permission-mode plan` (solo lectura) | `ReviewOutputSchema` vía `--json-schema`: proyecto, criterios, plan |
| DESARROLLANDO | Claude | `acceptEdits` + `--resume` de la sesión | `DevelopOutputSchema` + cambios reales detectados con git |
| PROBANDO | Orquestador + OpenCode | pruebas detectadas por el orquestador; luego OpenCode `dadqa` | `QaVerdictSchema` contrastado con las pruebas reales (`validateVerdict`) |
| DOCUMENTANDO | Claude + OpenCode | política `docs` (solo .md/.txt/README/CHANGELOG/docs/) | `DocumentOutputSchema` + `DocReviewSchema` |
| FINALIZADO | Orquestador | `finalCheck` | criterios cumplidos, pruebas en verde (o sin suite y no exigida), QA aprobado, sin violaciones |

Si QA rechaza: PROBANDO → rojo, DESARROLLANDO → amarillo, el reporte JSON (criterios no cumplidos,
issues, pruebas sugeridas, notas del orquestador, salida de pruebas) se entrega a Claude en la misma
sesión. Máximo `maxAttempts` (3 por defecto); al agotarlos la tarea termina en `failed` y FINALIZADO en rojo.

Los focos cambian **solo** cuando el orquestador llama a `setStage`, tras eventos reales
(fin de proceso, resultado de pruebas, veredicto validado). No hay temporizadores.

## Decisiones técnicas

- **Persistencia en JSON** (no SQLite): evita módulos nativos que deben recompilarse para cada
  versión de Electron. Escrituras atómicas (temporal + rename).
- **Ejecutables sin shell**: `claude.cmd`/`opencode.cmd` son shims de npm; se desenvuelven hasta
  `claude.exe`/`opencode.exe` y se lanzan con `shell:false`. Los argumentos nunca se interpretan.
  El PATH se reconstruye desde el registro (usuario + sistema) porque una app gráfica no hereda el
  PATH de una sesión de PowerShell.
- **Prompt de Claude por stdin** (sin límite de línea de comandos). OpenCode lo recibe tras `--`.
- **Salida estructurada**: Claude con `--json-schema` (campo `structured_output` del evento `result`).
  OpenCode no tiene salida forzada: se extrae el último bloque JSON y, si falta, se pide una vez más.
- **QA no escribe pruebas**: tiene permisos de solo lectura; propone pruebas en `suggested_tests` y
  Claude las implementa en la corrección. Evita worktrees sobre un vault con miles de cambios sin commitear.
- **Modelo de OpenCode**: no se emite en los eventos de `run`; se obtiene con `opencode export <sesión>`.

## Seguridad (impuesta por las CLI, no por prompt)

| Mecanismo | Dónde se aplica |
|---|---|
| Revisión de Claude en modo `plan` | Claude Code |
| `--permission-prompts none`: todo lo que pediría confirmación se deniega | Claude Code |
| Lista blanca de comandos (`--allowedTools Bash(npm test:*)…`) | Claude Code |
| Hook guardián `PreToolUse`: rutas permitidas, modo docs, bloqueo de escritura, comandos destructivos, respaldo previo de cada archivo | Claude Code ejecuta el hook; exit 2 bloquea |
| Agente `dadqa`: `edit`, `task`, `webfetch`, `external_directory` denegados; bash solo `git status/diff/log/show` | OpenCode (`OPENCODE_CONFIG_CONTENT`, se fusiona con tu config) |
| Detección de borrados de archivos preexistentes → tarea detenida | Orquestador (snapshots antes/después de cada etapa) |
| Una sola instancia de la app + `WriteLock` | Electron + hook |
| Tiempos máximos por etapa, cancelación con `taskkill /T /F`, registro de PIDs y limpieza de huérfanos al arrancar | `process-runner` |
| Nunca se usa `--dangerously-skip-permissions`, `bypassPermissions` ni `--auto` | — |

Copias de seguridad: antes de que Claude edite un archivo existente, el hook lo copia en
`%LOCALAPPDATA%\DualAgentDesktop\backups\<id-tarea>\<ruta relativa>` (solo la primera versión).

## Datos de la aplicación

`%LOCALAPPDATA%\DualAgentDesktop\`

| Ruta | Contenido |
|---|---|
| `settings.json` | Preferencias |
| `tasks/<id>.json` | Historial completo de cada tarea (eventos, cambios, pruebas, reportes QA) |
| `reports/<id>.md` | Resumen legible de cada tarea |
| `backups/<id>/` | Originales de los archivos que Claude editó |
| `policies/<id>.json` | Política de seguridad que lee el hook |
| `logs/guard.log` | Acciones bloqueadas por el hook |
| `run/` | PIDs en curso y bloqueo de escritura |
