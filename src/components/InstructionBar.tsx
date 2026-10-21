import { ArrowUp, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface Props {
  busy: boolean;
  disabled: boolean;
  onSubmit: (text: string) => Promise<boolean>;
  onCancel: () => void;
}

export function InstructionBar({ busy, disabled, onSubmit, onCancel }: Props) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Altura automática hasta un máximo; a partir de ahí, desplazamiento interno.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const send = async () => {
    if (!text.trim() || busy || disabled || sending) return;
    setSending(true);
    try {
      if (await onSubmit(text)) setText('');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="panel flex items-end gap-3 p-3 pl-5 focus-within:border-white/[0.14] transition-colors">
      <textarea
        ref={ref}
        aria-label="Instrucción para los agentes"
        value={text}
        rows={1}
        disabled={busy}
        placeholder="¿Qué quieres que hagan tus agentes?"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
        }}
        className="min-h-[44px] flex-1 resize-none bg-transparent py-2 text-[15px] leading-relaxed text-ink-100 placeholder:text-ink-500 outline-none disabled:opacity-60"
      />
      <div className="flex flex-col items-end gap-1.5 pb-0.5">
        <span className="text-[11px] text-ink-500 select-none">{busy ? 'Tarea en curso' : 'Ctrl + Enter'}</span>
        {busy ? (
          <button
            type="button"
            onClick={onCancel}
            title="Cancelar la tarea en curso"
            className="flex h-10 items-center gap-2 rounded-xl bg-red-500/15 px-4 text-sm font-medium text-red-300 ring-1 ring-red-400/30 hover:bg-red-500/25 active:scale-[0.97] transition"
          >
            <Square size={14} fill="currentColor" /> Cancelar
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void send()}
            disabled={!text.trim() || disabled || sending}
            title="Enviar instrucción (Ctrl + Enter)"
            aria-label="Enviar instrucción"
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-ink-100 text-coal-900 hover:bg-white active:scale-[0.95] disabled:bg-coal-700 disabled:text-ink-500 transition"
          >
            <ArrowUp size={18} strokeWidth={2.4} />
          </button>
        )}
      </div>
    </div>
  );
}
