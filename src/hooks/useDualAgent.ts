import { useCallback, useEffect, useState } from 'react';
import type { AppSnapshot, DadApi } from '../../shared/types';

function api(): DadApi {
  return window.dad;
}

/** Refleja el estado del proceso principal; la interfaz no tiene estado de negocio propio. */
export function useDualAgent() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api()
      .getSnapshot()
      .then((s) => alive && setSnapshot(s))
      .catch((e) => alive && setError(String(e)));
    const off = api().onSnapshot((s) => setSnapshot(s));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const submit = useCallback(async (instruction: string) => {
    setError(null);
    const r = await api().submit(instruction);
    if (!r.ok) setError(r.error ?? 'No se pudo enviar la instrucción.');
    return r.ok;
  }, []);

  const cancel = useCallback(() => api().cancel(), []);
  const refresh = useCallback(async () => setSnapshot(await api().refreshEnvironment()), []);

  return { snapshot, error, setError, submit, cancel, refresh };
}
