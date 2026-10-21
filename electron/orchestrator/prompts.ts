import type { ChangedFile, QaReport, TestRun } from '../../shared/types';

// Las instrucciones del usuario van delimitadas para que no se confundan con las del orquestador.
const quote = (s: string) => `<<<INSTRUCCION_USUARIO\n${s}\nINSTRUCCION_USUARIO>>>`;
const list = (xs: string[]) => (xs.length ? xs.map((x, i) => `${i + 1}. ${x}`).join('\n') : '(ninguno)');
const files = (cs: ChangedFile[]) =>
  cs.length ? cs.map((c) => `- [${c.kind}] ${c.path}${c.preexisting ? ' (ya tenía cambios del usuario antes de la tarea)' : ''}`).join('\n') : '(ningún archivo cambió)';

export function reviewPrompt(instruction: string, workspace: string): string {
  return `ETAPA: REVISIÓN (solo lectura — no modifiques nada).
Directorio de trabajo: ${workspace}
Este directorio puede contener varios proyectos y notas. Antes de proponer cambios identifica cuál es el proyecto relevante.

${quote(instruction)}

Haz lo siguiente:
1. Explora lo necesario para identificar la carpeta del proyecto relevante (ruta RELATIVA al directorio de trabajo, con "/").
   Si la instrucción requiere crear un proyecto nuevo, propone una carpeta nueva que no exista y marca project_exists=false.
   Usa "." solo si el cambio afecta realmente a la raíz.
2. Define criterios de aceptación concretos y verificables (lo que QA comprobará).
3. Redacta un plan breve de implementación y los riesgos (archivos del usuario que podrían verse afectados, etc.).
Entrega el resultado con la salida estructurada.`;
}

export function developPrompt(args: {
  instruction: string;
  projectPath: string;
  criteria: string[];
  plan: string[];
  attempt: number;
  maxAttempts: number;
  lastReport?: QaReport | null;
  lastTest?: TestRun | null;
}): string {
  const head = `ETAPA: DESARROLLO — intento ${args.attempt} de ${args.maxAttempts}.
Proyecto objetivo: ${args.projectPath}  (solo puedes escribir dentro de esta ruta)

${quote(args.instruction)}

Criterios de aceptación:
${list(args.criteria)}

Plan:
${list(args.plan)}
`;
  if (args.attempt === 1 || !args.lastReport) {
    return `${head}
Implementa los cambios. Si el proyecto tiene pruebas, añade o actualiza las que cubran los criterios.
No borres, muevas ni renombres archivos existentes. Al terminar entrega la salida estructurada.`;
  }
  const r = args.lastReport;
  const v = r.reported;
  return `${head}
CORRECCIÓN: el intento anterior NO fue aprobado. Reporte estructurado de QA y del orquestador:
${JSON.stringify(
  {
    qa_verdict: v?.verdict ?? 'sin veredicto válido',
    qa_summary: v?.summary,
    unmet_criteria: v?.criteria.filter((c) => !c.met) ?? [],
    issues: v?.issues ?? [],
    suggested_tests: v?.suggested_tests ?? [],
    orchestrator_notes: r.orchestratorNotes,
  },
  null,
  2,
)}

Resultado de las pruebas automáticas: ${args.lastTest ? `${args.lastTest.status}${args.lastTest.command ? ` (${args.lastTest.command})` : ''}` : 'no ejecutadas'}
${args.lastTest && args.lastTest.status !== 'passed' ? `Últimas líneas de salida:\n${args.lastTest.outputTail.slice(-4000)}` : ''}

Corrige TODOS los problemas indicados. Si QA sugirió pruebas, impleméntalas. Al terminar entrega la salida estructurada.`;
}

export function qaPrompt(args: {
  instruction: string;
  projectPath: string;
  criteria: string[];
  devSummary: string;
  changed: ChangedFile[];
  test: TestRun;
  attempt: number;
  requireTests: boolean;
}): string {
  return `Eres el agente QA / TESTER de "Dual Agent Desktop". Tu trabajo es revisar, NO modificar (tus permisos son de solo lectura).
Directorio de trabajo: el actual. Proyecto revisado: ${args.projectPath}
Revisión número ${args.attempt}.

Instrucción original del usuario:
${quote(args.instruction)}

Criterios de aceptación a verificar (evalúa TODOS, en este orden):
${list(args.criteria)}

Resumen del desarrollador:
${args.devSummary || '(sin resumen)'}

Archivos modificados en esta tarea (detectados por el orquestador con git, no por el desarrollador):
${files(args.changed)}

Pruebas automáticas ejecutadas por el orquestador:
- estado: ${args.test.status}
- comando: ${args.test.command ?? 'ninguno detectado'}
- código de salida: ${args.test.exitCode ?? '-'}
${args.test.outputTail ? `- salida (final):\n${args.test.outputTail.slice(-5000)}` : ''}
${args.test.status === 'none' ? (args.requireTests ? 'ATENCIÓN: este proyecto exige pruebas automatizadas y no se detectó ninguna suite.' : 'No hay suite de pruebas: verifica los criterios leyendo el código.') : ''}

Tareas:
1. Lee el código de los archivos modificados y lo necesario de su contexto.
2. Busca defectos, errores de lógica, casos límite, problemas de seguridad y requisitos no cumplidos.
3. Comprueba cada criterio con evidencia concreta (archivo/línea o resultado de prueba).
4. Indica si la documentación del proyecto (README, docs, changelog) necesita actualizarse por estos cambios.
5. Si faltan pruebas, propónlas en "suggested_tests" (no las escribas tú).

Termina tu respuesta con UN bloque \`\`\`json con exactamente esta forma:
{
  "verdict": "approved" | "rejected",
  "summary": "resumen breve",
  "criteria": [{ "criterion": "texto del criterio", "met": true, "evidence": "..." }],
  "issues": [{ "severity": "critical" | "major" | "minor", "file": "ruta", "description": "...", "suggestion": "..." }],
  "suggested_tests": ["..."],
  "documentation": { "needs_update": true, "targets": ["README.md"], "notes": "..." }
}
Usa "approved" solo si todos los criterios se cumplen y no hay problemas critical/major.`;
}

export const QA_JSON_RETRY = `Tu respuesta anterior no contenía un bloque JSON válido con el veredicto.
Responde ÚNICAMENTE con el bloque \`\`\`json del veredicto, con la forma indicada (verdict, summary, criteria, issues, suggested_tests, documentation).`;

export function documentPrompt(args: { instruction: string; projectPath: string; verified: string[]; changed: ChangedFile[]; targets: string[]; notes?: string; previousIssues?: string[] }): string {
  return `ETAPA: DOCUMENTACIÓN. Las pruebas y QA ya aprobaron la implementación.
Proyecto: ${args.projectPath}

${quote(args.instruction)}

Comportamiento VERIFICADO por QA (documenta solo esto, no inventes funcionalidades):
${list(args.verified)}

Archivos modificados:
${files(args.changed)}

Documentos que QA sugiere actualizar: ${args.targets.length ? args.targets.join(', ') : '(a tu criterio: README, docs/, CHANGELOG)'}
${args.notes ? `Notas de QA: ${args.notes}` : ''}
${args.previousIssues?.length ? `\nLa revisión anterior de la documentación fue rechazada por:\n${list(args.previousIssues)}\nCorrígelo.` : ''}

Actualiza solo archivos de documentación (.md, .txt, README, CHANGELOG, docs/). En esta etapa no puedes tocar código.
Si no hace falta documentar nada, no modifiques archivos y explica el motivo en skipped_reason. Entrega la salida estructurada.`;
}

export function docReviewPrompt(args: { verified: string[]; docFiles: ChangedFile[] }): string {
  return `Revisión de DOCUMENTACIÓN (solo lectura).
Se actualizaron estos documentos:
${files(args.docFiles)}

Comportamiento verificado de la tarea:
${list(args.verified)}

Lee los documentos modificados y comprueba que describen solo comportamiento realmente implementado y verificado, sin inventar funcionalidades, y que las instrucciones son correctas.
Termina con UN bloque \`\`\`json: { "verdict": "approved" | "rejected", "summary": "...", "issues": ["..."] }`;
}
