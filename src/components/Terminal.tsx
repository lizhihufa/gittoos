import { useEffect, useRef, useState, type CSSProperties } from "react";

interface Props {
  text: string;
  onClear: () => void;
  onRun?: (line: string) => void;
  busy?: boolean;
  embedded?: boolean;
  wallpaperUrl?: string | null;
  wallpaperKind?: "image" | "video" | "none";
  wallpaperScrim?: number;
}

export function Terminal({
  text,
  onClear,
  onRun,
  busy = false,
  embedded = false,
  wallpaperUrl = null,
  wallpaperKind = "none",
  wallpaperScrim = 55,
}: Props) {
  const preRef = useRef<HTMLPreElement>(null);
  const [line, setLine] = useState("");
  const hasWallpaper =
    Boolean(wallpaperUrl) &&
    (wallpaperKind === "image" || wallpaperKind === "video");
  const scrim = Math.max(0, Math.min(90, wallpaperScrim)) / 100;

  useEffect(() => {
    const el = preRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [text]);

  return (
    <section
      className={`terminal${embedded ? " terminal-embedded" : ""}${
        hasWallpaper ? " has-wallpaper" : ""
      }`}
      style={
        hasWallpaper
          ? ({
              ["--terminal-wallpaper-scrim" as string]: String(scrim),
            } as CSSProperties)
          : undefined
      }
    >
      {hasWallpaper && wallpaperUrl && (
        <div className="terminal-wallpaper" aria-hidden>
          {wallpaperKind === "video" ? (
            <video
              className="terminal-wallpaper-media"
              src={wallpaperUrl}
              muted
              autoPlay
              loop
              playsInline
            />
          ) : (
            <img
              className="terminal-wallpaper-media"
              src={wallpaperUrl}
              alt=""
              draggable={false}
            />
          )}
          <div className="terminal-wallpaper-scrim" />
        </div>
      )}
      <div className="terminal-chrome">
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
      </div>
    </section>
  );
}
