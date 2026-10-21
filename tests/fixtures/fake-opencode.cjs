// CLI simulada de OpenCode: reproduce el formato de `opencode run --format json`
// observado en opencode 1.19.0. Escenario por FAKE_SCENARIO.
const fs = require('fs');
const args = process.argv.slice(2);
const scenario = process.env.FAKE_SCENARIO || 'ok';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sid = 'ses_fake1';
const ev = (type, part) => out({ type, timestamp: Date.now(), sessionID: sid, part });

if (args[0] === '--version') {
  console.log('1.2.3');
  process.exit(0);
}
if (args[0] === 'providers') {
  console.log('\x1b[0m\nT  Credentials ~/.local/share/opencode/auth.json\n|\n•  GitHub Copilot oauth\n|\n—  1 credentials');
  process.exit(0);
}
if (args[0] === 'export') {
  console.log(JSON.stringify({ info: { id: args[1], model: { id: 'fake-free', providerID: 'opencode' } } }));
  process.exit(0);
}
if (args[0] === 'run') {
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, config: process.env.OPENCODE_CONFIG_CONTENT }) + '\n');
  if (scenario === 'hang') {
    ev('step_start', { type: 'step-start' });
    setInterval(() => {}, 1000);
    return;
  }
  if (scenario === 'error') {
    out({ type: 'error', timestamp: Date.now(), sessionID: sid, error: { name: 'ProviderAuthError', data: { message: 'ProviderAuthError: 401 unauthorized' } } });
    process.exit(1);
  }
  ev('step_start', { type: 'step-start' });
  ev('tool_use', { type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: 'C:\\w\\app\\index.js' } } });
  ev('tool_use', { type: 'tool', tool: 'bash', state: { status: 'error', input: { command: 'rm x' }, error: 'The user has specified a rule which prevents you from using this specific tool call.' } });
  const verdict = { verdict: 'approved', summary: 'todo ok', criteria: [{ criterion: 'c1', met: true, evidence: 'línea 3' }], issues: [], suggested_tests: [], documentation: { needs_update: false, targets: [] } };
  const text = scenario === 'no_json' ? 'Revisé el código y está bien.' : 'Revisión completa.\n```json\n' + JSON.stringify(verdict) + '\n```';
  ev('text', { type: 'text', text });
  ev('step_finish', { type: 'step-finish', reason: 'stop', tokens: { total: 100 } });
  process.exit(0);
}
process.exit(2);
