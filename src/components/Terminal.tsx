import { useEffect, useRef, useState } from "react";

interface Props {
  text: string;
  onClear: () => void;
  onRun?: (line: string) => void;
  busy?: boolean;
  embedded?: boolean;
}

export function Terminal({ text, onClear, onRun, busy = false, embedded = false }: Props) {
  const preRef = useRef<HTMLPreElement>(null);
  const [line, setLine] = useState("");

  useEffect(() => {
    const el = preRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [text]);

  return (
    <section className={embedded ? "terminal terminal-embedded" : "terminal"}>
      <div className="terminal-header">
        <strong>终端</strong>
        <button type="button" onClick={onClear}>
          清空
        </button>
      </div>
      <pre ref={preRef} className="terminal-body">
        {text || "可输入 git 或其他命令，在当前仓库目录执行。"}
      </pre>
      {onRun && (
        <form
          className="terminal-input"
          onSubmit={(event) => {
            event.preventDefault();
            const next = line.trim();
            if (!next || busy) return;
            setLine("");
            onRun(next);
          }}
        >
          <span>$</span>
          <input
            value={line}
            onChange={(event) => setLine(event.target.value)}
            placeholder="输入命令，回车执行"
            disabled={busy}
            spellCheck={false}
          />
        </form>
      )}
    </section>
  );
}
