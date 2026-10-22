// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/App';
import type { AgentState, AppSnapshot, DadApi, TaskRecord } from '../../shared/types';

// La interfaz se prueba con un proceso principal simulado; las CLIs reales se prueban aparte.
const agent = (id: 'claude' | 'opencode', over: Partial<AgentState> = {}): AgentState => ({
  id,
  name: id === 'claude' ? 'Claude Code' : 'OpenCode',
  role: id === 'claude' ? 'DESARROLLADOR' : 'QA / TESTER',
  executable: 'x',
  version: '1.0',
  model: null,
  connected: true,
  auth: { ok: true, detail: 'ok' },
  status: 'idle',
  currentTask: null,
  lastAction: null,
  lastError: null,
  activity: [],
  ...over,
});
const baseSnap = (): AppSnapshot => ({
  workspace: { path: 'C:\\RONNY\\MIND\\CEREBRO', exists: true, readable: true, writable: true, isGitRepo: true, gitBranch: 'main', preexistingChanges: 3, tools: [], checkedAt: 0 },
  agents: { claude: agent('claude'), opencode: agent('opencode') },
  task: null,
  settings: { workspace: 'C:\\RONNY\\MIND\\CEREBRO', recentWorkspaces: ['C:\\RONNY\\MIND\\CEREBRO', 'C:\\RONNY\\MIND\\PROYECTOS'], maxAttempts: 3, requireTests: false, claudeModel: '', opencodeModel: '', extraWritablePaths: [], timeouts: { reviewMin: 1, developMin: 1, testMin: 1, qaMin: 1, documentMin: 1 } },
  busy: false,
});
const task = (stages: TaskRecord['stages']): TaskRecord => ({
  id: 't-1', instruction: 'x', createdAt: 0, updatedAt: 0, status: 'running', responsible: 'claude', currentStage: 'develop', stages,
  attempts: 2, maxAttempts: 3, projectPath: 'app', acceptanceCriteria: [], plan: [], events: [{ ts: 0, level: 'error', stage: 'test', agent: 'opencode', message: 'Veredicto QA: RECHAZADO' }],
  changedFiles: [], testRuns: [], qaReports: [], violations: [], sessions: { claude: null, opencode: null }, backupDir: null, summary: null, finalResult: null,
});

let push: (s: AppSnapshot) => void;
let api: { [K in keyof DadApi]: ReturnType<typeof vi.fn> };

beforeEach(() => {
  api = {
    getSnapshot: vi.fn(async () => baseSnap()),
    submit: vi.fn(async () => ({ ok: true, taskId: 't-1' })),
    cancel: vi.fn(async () => ({ ok: true })),
    refreshEnvironment: vi.fn(async () => baseSnap()),
    listHistory: vi.fn(async () => []),
    getTask: vi.fn(async () => null),
    updateSettings: vi.fn(async (p) => ({ ...baseSnap().settings, ...p })),
    openPath: vi.fn(async () => {}),
    chooseWorkspace: vi.fn(async () => null),
    setWorkspace: vi.fn(async () => ({ ok: false, error: 'No existe la carpeta C:\\RONNY\\MIND\\PROYECTOS.' })),
    onSnapshot: vi.fn((cb) => {
      push = cb;
      return () => {};
    }),
  };
  (window as unknown as { dad: unknown }).dad = api;
});
afterEach(cleanup);

describe('Interfaz principal', () => {
  it('muestra la barra, los dos agentes, los cinco focos en gris y la actividad', async () => {
    render(<App />);
    expect(await screen.findByPlaceholderText('¿Qué quieres que hagan tus agentes?')).toBeInTheDocument();
    expect(screen.getByText('CLAUDE CODE')).toBeInTheDocument();
    expect(screen.getByText('OPENCODE')).toBeInTheDocument();
    expect(screen.getByText('DESARROLLADOR')).toBeInTheDocument();
    expect(screen.getByText('QA / TESTER')).toBeInTheDocument();
    for (const id of ['review', 'develop', 'test', 'document', 'done']) expect(screen.getByTestId(`led-${id}`)).toHaveAttribute('data-state', 'pending');
    expect(screen.getByText('REVISANDO')).toBeInTheDocument();
    expect(screen.getByText('FINALIZADO')).toBeInTheDocument();
    expect(screen.getByText(/Actividad reciente/i)).toBeInTheDocument();
  });

  it('envía con Ctrl + Enter (y Enter solo inserta salto de línea)', async () => {
    const user = userEvent.setup();
    render(<App />);
    const box = await screen.findByPlaceholderText('¿Qué quieres que hagan tus agentes?');
    await user.type(box, 'línea 1{Enter}línea 2');
    expect(api.submit).not.toHaveBeenCalled();
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(api.submit).toHaveBeenCalledWith('línea 1\nlínea 2');
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('refleja en tiempo real los colores de los focos y el estado de cada agente', async () => {
    render(<App />);
    await screen.findByText('CLAUDE CODE');
    act(() =>
      push({
        ...baseSnap(),
        busy: true,
        agents: {
          claude: agent('claude', { status: 'working', currentTask: 'Corrigiendo (intento 2/3)', lastAction: 'Editando …/app/index.js', model: 'claude-opus-5-5', activity: [{ ts: 0, level: 'info', text: 'Editando …/app/index.js' }] }),
          opencode: agent('opencode', { status: 'error', lastError: { kind: 'test_failure', message: 'Falla X', ts: 0 } }),
        },
        task: task({ review: 'done', develop: 'active', test: 'error', document: 'pending', done: 'pending' }),
      }),
    );
    expect(screen.getByTestId('led-review')).toHaveAttribute('data-state', 'done');
    expect(screen.getByTestId('led-develop')).toHaveAttribute('data-state', 'active');
    expect(screen.getByTestId('led-test')).toHaveAttribute('data-state', 'error');
    expect(screen.getByTestId('status-claude')).toHaveTextContent('Trabajando');
    expect(screen.getByTestId('status-opencode')).toHaveTextContent('Error');
    expect(screen.getByText('Corrigiendo (intento 2/3)')).toBeInTheDocument();
    expect(screen.getByText('claude-opus-5-5')).toBeInTheDocument();
    expect(screen.getByText(/Defectos detectados/)).toBeInTheDocument();
    expect(screen.getByText('Veredicto QA: RECHAZADO')).toBeInTheDocument();
    expect(screen.getByText('Intento 2/3')).toBeInTheDocument();
  });

  it('con una tarea en curso muestra Cancelar y lo envía al proceso principal', async () => {
    const user = userEvent.setup();
    api.getSnapshot.mockResolvedValue({ ...baseSnap(), busy: true, task: task({ review: 'active', develop: 'pending', test: 'pending', document: 'pending', done: 'pending' }) });
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Cancelar/ }));
    expect(api.cancel).toHaveBeenCalled();
  });

  it('muestra el error devuelto al enviar', async () => {
    const user = userEvent.setup();
    api.submit.mockResolvedValue({ ok: false, error: 'Ya hay una tarea en curso.' });
    render(<App />);
    await user.type(await screen.findByPlaceholderText(/agentes/), 'x');
    await user.click(screen.getByRole('button', { name: 'Enviar instrucción' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Ya hay una tarea en curso.');
  });

  it('deshabilita el envío si un agente no está conectado', async () => {
    api.getSnapshot.mockResolvedValue({ ...baseSnap(), agents: { claude: agent('claude'), opencode: agent('opencode', { connected: false, status: 'offline' }) } });
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByPlaceholderText(/agentes/), 'x');
    expect(screen.getByRole('button', { name: 'Enviar instrucción' })).toBeDisabled();
    expect(screen.getByTestId('status-opencode')).toHaveTextContent('Sin conexión');
  });

  it('cambia la carpeta de trabajo desde el encabezado (recientes y selector)', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('workspace'));
    await user.click(screen.getByRole('menuitem', { name: 'C:\\RONNY\\MIND\\PROYECTOS' }));
    expect(api.setWorkspace).toHaveBeenCalledWith('C:\\RONNY\\MIND\\PROYECTOS');
    expect(await screen.findByRole('alert')).toHaveTextContent('No existe la carpeta');
    await user.click(screen.getByTestId('workspace'));
    await user.click(screen.getByRole('menuitem', { name: /Elegir otra carpeta/ }));
    expect(api.chooseWorkspace).toHaveBeenCalled();
  });
});
