# Dual Agent Desktop

Aplicación de escritorio para Windows que coordina dos agentes de IA sobre el mismo proyecto:

- **Claude Code** — desarrollador: revisa el proyecto, define criterios de aceptación, implementa, corrige y documenta.
- **OpenCode** — QA / tester (solo lectura): revisa el código, valida los criterios contra los resultados reales de las pruebas y emite un veredicto estructurado.

Un orquestador interno ejecuta las CLI reales instaladas, valida cada mensaje JSON, corre las pruebas del proyecto, devuelve los rechazos al desarrollador (máx. 3 intentos) y muestra el progreso en cinco focos LED: **REVISANDO · DESARROLLANDO · PROBANDO · DOCUMENTANDO · FINALIZADO**.

Carpeta de trabajo: `C:\RONNY\MIND\CEREBRO` por defecto; se puede cambiar a cualquier otra carpeta desde el encabezado. Los datos internos de la app se guardan en `%LOCALAPPDATA%\DualAgentDesktop`.

Arquitectura, flujo y modelo de seguridad: [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md).

## Requisitos

| Requisito | Comprobado con |
|---|---|
| Windows 10/11 x64 | — |
| Claude Code instalado y con sesión iniciada | `claude --version`, `claude auth status` (si falta: `claude auth login`) |
| OpenCode instalado | `opencode --version` (los modelos gratuitos `opencode/*` no requieren credenciales) |
| Git | `git --version` |
| Node.js ≥ 20 (solo para desarrollar/compilar) | `node --version` |

La app encuentra `claude.exe` y `opencode.exe` aunque se abra desde el escritorio: lee el PATH del registro y `%APPDATA%\npm`. Para forzar una ruta, define `DAD_CLAUDE_PATH` o `DAD_OPENCODE_PATH`.

## Instalación

1. Ejecuta `release\DualAgentDesktop-Setup-1.0.0.exe`.
2. Crea accesos directos en el escritorio y en el menú Inicio ("Dual Agent Desktop").
3. El instalador no está firmado: Windows SmartScreen puede pedir "Más información → Ejecutar de todas formas".

## Uso

1. Abre la app. El encabezado muestra la carpeta de trabajo y su rama git. Haz clic en la ruta para cambiarla: carpetas recientes, **Elegir otra carpeta…** (selector de Windows) o abrirla en el explorador. No se puede cambiar con una tarea en curso. Cada panel muestra la versión, la autenticación y el modelo de su agente.
2. Escribe la instrucción y pulsa **Ctrl + Enter** (Enter solo agrega un salto de línea).
3. Sigue el progreso en los focos, en los paneles de los agentes y en la actividad reciente.
4. **Cancelar** detiene ambos agentes y mata sus procesos.
5. **Historial** (icono de reloj) muestra cada ejecución: resumen, pruebas, reportes de QA y eventos.
6. **Configuración** (engranaje): número máximo de intentos, exigir suite de pruebas, modelos, rutas escribibles adicionales y tiempos máximos por etapa.

Consejo: menciona el proyecto en la instrucción ("En 02 Proyectos/SmartBite …"). Claude lo identifica en la revisión y solo podrá escribir dentro de esa carpeta y de las rutas extra (`01 Diario` por defecto; se ignoran si no existen en la carpeta de trabajo).

El proyecto debe estar **dentro** de la carpeta de trabajo. Si está en otro sitio (por ejemplo `C:\RONNY\MIND\PROYECTOS\smartbite`), cambia la carpeta de trabajo a esa carpeta o a una que la contenga; si no, la tarea se detiene en REVISANDO con el error de política "fuera del directorio de trabajo".

## Desarrollo

```bash
npm install
npm run dev          # Vite + Electron con recarga del renderer
npm test             # pruebas unitarias, de integración (CLIs simuladas) y de interfaz
npm run test:real    # pruebas contra las CLI reales (consume uso de Claude/OpenCode)
npm run typecheck
npm start            # compila y abre la app
npm run dist         # genera release\DualAgentDesktop-Setup-<versión>.exe
node scripts/make-icon.cjs   # regenera resources/icon.png
```

## Pruebas ejecutadas

| Suite | Resultado |
|---|---|
| `tests/unit/orchestrator.test.ts`: flujo completo y secuencia de focos, rechazo → vuelta a desarrollo, límite de intentos, QA "approved" invalidado por pruebas fallidas, JSON de QA inválido, cancelación, borrado de archivo preexistente, cambios previos del usuario, ruta fuera del workspace, una tarea a la vez, error de autenticación, etapa de documentación | 17/17 ✔ |
| `tests/unit/security.test.ts`: hook guardián ejecutado como proceso real (alcance, `.git`/`.obsidian`, solo lectura, modo docs, bloqueo de escritura, 13 comandos destructivos, falla cerrado) y `WriteLock` | 28/28 ✔ |
| `tests/unit/services.test.ts`: git en repositorio real, detección/ejecución de pruebas, timeout, cancelación con muerte del árbol de procesos, ausencia de shell, extracción de JSON, clasificación de errores, ocultamiento de tokens, persistencia | 19/19 ✔ |
| `tests/integration/adapters.test.ts`: adaptadores reales contra CLIs simuladas con el protocolo NDJSON observado | 12/12 ✔ |
| `tests/ui/app.test.tsx`: barra, paneles, focos, Ctrl+Enter, estados en tiempo real, cancelar, errores, cambio de carpeta de trabajo | 7/7 ✔ |
| `tests/unit/workspace.test.ts`: cambio de carpeta de trabajo (persistencia, recientes; rechaza rutas inexistentes, relativas, raíz de unidad y datos de la app) | 2/2 ✔ |
| `tests/integration/real-cli.test.ts` (**CLI reales**): detección y autenticación; OpenCode QA no puede escribir ni borrar; ciclo completo real en un sandbox (Claude 2.1.306 + OpenCode 1.19.0): proyecto `calc` identificado, 9 criterios, `npm test` en verde, QA 9/9, solo cambió `calc/`; revisión de solo lectura sobre CEREBRO sin ningún cambio | 4/4 ✔ |
| Prueba de humo de la app Electron real y del `.exe` empaquetado (`DAD_SCREENSHOT`): CEREBRO, Git, Claude autenticado y OpenCode detectados | ✔ |

## Limitaciones conocidas

- **Una tarea a la vez.** Las etapas son secuenciales: los agentes nunca escriben a la vez.
- **El QA no ejecuta pruebas por su cuenta.** Su bash se limita a consultas de git. Las pruebas las ejecuta el orquestador y QA recibe el resultado.
- **Detección de pruebas por manifiesto**: `package.json` (script `test`), `mvnw`/`pom.xml`, `gradlew`/`build.gradle`, `Cargo.toml`, `go.mod`, `pytest`. Si no hay suite, la tarea puede finalizar con la aprobación de QA, salvo que actives "Exigir suite de pruebas".
- **La documentación solo se actualiza si QA lo indica.** Si Claude ya documentó durante el desarrollo, la etapa DOCUMENTANDO se completa sin cambios.
- **Claude no ejecuta comandos fuera de la lista blanca.** Incluye comandos compuestos como `cd x; node --test`: se deniegan automáticamente, lo cual es intencional.
- **El modelo de OpenCode** se muestra después de su primera ejecución, porque se obtiene con `opencode export`.
- **El instalador no está firmado** con un certificado de código.
- Si se cierra la app a mitad de una tarea, al reabrirla esa tarea queda como "cancelada" y se matan los procesos huérfanos registrados.
