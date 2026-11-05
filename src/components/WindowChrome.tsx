import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

type Props = {
  /** Transparent chrome so wallpaper can show through (welcome / boot). */
  overlay?: boolean;
  title?: string;
};

export function WindowChrome({ overlay = false, title = "青枝" }: Props) {
  const [maximized, setMaximized] = useState(false);

  const refreshMaximized = useCallback(async () => {
    try {
      setMaximized(await getCurrentWindow().isMaximized());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void refreshMaximized();
    const appWindow = getCurrentWindow();
    let unlistenResize: (() => void) | undefined;
    let unlistenMove: (() => void) | undefined;
    void appWindow
      .onResized(() => {
        void refreshMaximized();
      })
      .then((fn) => {
        unlistenResize = fn;
      });
    void appWindow
      .onMoved(() => {
        void refreshMaximized();
      })
      .then((fn) => {
        unlistenMove = fn;
      });
    return () => {
      unlistenResize?.();
      unlistenMove?.();
    };
  }, [refreshMaximized]);

  return (
    <div
      className={`window-chrome${overlay ? " is-overlay" : ""}`}
      data-tauri-drag-region
      onDoubleClick={() => {
        void getCurrentWindow().toggleMaximize();
      }}
    >
      <div className="window-chrome-title" data-tauri-drag-region>
        {title}
      </div>
      <div className="window-chrome-controls">
        <button
          type="button"
          className="window-chrome-btn"
          aria-label="最小化"
          title="最小化"
          onClick={() => void getCurrentWindow().minimize()}
        >
          <span aria-hidden>—</span>
        </button>
        <button
          type="button"
          className="window-chrome-btn"
          aria-label={maximized ? "还原" : "最大化"}
          title={maximized ? "还原" : "最大化"}
          onClick={() => void getCurrentWindow().toggleMaximize()}
        >
          <span aria-hidden>{maximized ? "❐" : "□"}</span>
        </button>
        <button
          type="button"
          className="window-chrome-btn is-close"
          aria-label="关闭"
          title="关闭"
          onClick={() => void getCurrentWindow().close()}
        >
          <span aria-hidden>×</span>
        </button>
      </div>
    </div>
  );
}
