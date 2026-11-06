import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

type Props = {
  /** Transparent chrome so wallpaper can show through (welcome / boot). */
  overlay?: boolean;
  title?: string;
};

function IconMinimize() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <path
        d="M2 6h8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconMaximize() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <rect
        x="2.2"
        y="2.2"
        width="7.6"
        height="7.6"
        rx="1.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  );
}

function IconRestore() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <path
        d="M3.8 4.2h5v5h-5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path
        d="M3.2 7.8H2.4a.6.6 0 0 1-.6-.6V2.8a.6.6 0 0 1 .6-.6h4.4a.6.6 0 0 1 .6.6v.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
      />
    </svg>
  );
}

function IconClose() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <path
        d="M3 3l6 6M9 3L3 9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

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
    <div className={`window-chrome${overlay ? " is-overlay" : ""}`}>
      <div
        className="window-chrome-drag"
        data-tauri-drag-region
        onDoubleClick={() => {
          void (async () => {
            await getCurrentWindow().toggleMaximize();
            await refreshMaximized();
          })();
        }}
      >
        <span className="window-chrome-title">{title}</span>
      </div>
      <div className="window-chrome-controls">
        <button
          type="button"
          className="window-chrome-btn is-min"
          aria-label="最小化"
          title="最小化"
          onClick={() => void getCurrentWindow().minimize()}
        >
          <IconMinimize />
        </button>
        <button
          type="button"
          className="window-chrome-btn is-max"
          aria-label={maximized ? "还原" : "最大化"}
          title={maximized ? "还原" : "最大化"}
          onClick={() =>
            void (async () => {
              await getCurrentWindow().toggleMaximize();
              await refreshMaximized();
            })()
          }
        >
          {maximized ? <IconRestore /> : <IconMaximize />}
        </button>
        <button
          type="button"
          className="window-chrome-btn is-close"
          aria-label="关闭"
          title="关闭"
          onClick={() => void getCurrentWindow().close()}
        >
          <IconClose />
        </button>
      </div>
    </div>
  );
}
