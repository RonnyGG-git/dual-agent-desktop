// CLI simulada de Claude Code: reproduce el formato stream-json observado en
// claude 2.1.306 (`-p --output-format stream-json --verbose`). Escenario por FAKE_SCENARIO.
const fs = require('fs');
const args = process.argv.slice(2);
const scenario = process.env.FAKE_SCENARIO || 'ok';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

if (args[0] === '--version') {
  console.log('9.9.9 (Claude Code)');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify(scenario === 'logged_out' ? { loggedIn: false } : { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro', email: 'secreto@x.com' }));
  process.exit(scenario === 'logged_out' ? 1 : 0);
}

let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, stdin, env: { DAD_POLICY_FILE: process.env.DAD_POLICY_FILE, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE, CLAUDECODE: process.env.CLAUDECODE } }) + '\n');
  const sid = 'sess-123';
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-test-1', permissionMode: args[args.indexOf('--permission-mode') + 1], tools: [] });

  if (scenario === 'hang') {
    setInterval(() => {}, 1000);
    return;
  }
  if (scenario === 'auth_error') {
    out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } });
    out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', session_id: sid });
    process.exit(1);
  }
  if (scenario === 'rate_limit') {
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' }, session_id: sid });
    out({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit", session_id: sid });
    process.exit(1);
  }
  out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: 'Analizando el proyecto' }, { type: 'tool_use', name: 'Read', input: { file_path: 'C:\\w\\app\\index.js' } }] } });
  out({ type: 'user', session_id: sid, message: { content: [{ type: 'tool_result', is_error: true, content: 'PreToolUse:Write hook error: [Dual Agent Desktop] Acción bloqueada: ruta fuera del alcance' }] } });
  out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } });
  const structured = scenario === 'no_structured' ? undefined : { project_path: 'app', project_exists: true, summary: 'ok', acceptance_criteria: ['c1'], plan: [], risks: [] };
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, duration_ms: 1200, result: 'listo', structured_output: structured, session_id: sid, permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'curl x' } }] });
  process.exit(0);
});
