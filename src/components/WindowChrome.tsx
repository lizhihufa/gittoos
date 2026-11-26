import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

type Props = {
  /** Transparent chrome so wallpaper can show through (welcome / boot). */
  overlay?: boolean;
  /** App version string, e.g. "1.6.1" */
  version?: string;
  /** When true, show upgrade arrow; otherwise show refresh to re-check. */
  updateAvailable?: boolean;
  updateBusy?: boolean;
  onCheckUpdate?: () => void;
  /** Click when an update is available (e.g. open About). */
  onUpdateClick?: () => void;
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

function IconArrowUp() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <path
        d="M6 9.5V2.8M3.2 5.2L6 2.5l2.8 2.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconRefresh() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <path
        d="M9.6 4.2A3.9 3.9 0 1 0 10 6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
      <path
        d="M9.6 2.2v2.4H7.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function WindowChrome({
  overlay = false,
  version,
  updateAvailable = false,
  updateBusy = false,
  onCheckUpdate,
  onUpdateClick,
}: Props) {
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

  const versionLabel =
    version && version !== "…" ? `v${version.replace(/^v/i, "")}` : "";
  const titleText = versionLabel ? `青枝 ${versionLabel}` : "青枝";

  return (
    <div className={`window-chrome${overlay ? " is-overlay" : ""}`}>
      <div className="window-chrome-brand">
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
          <img
            className="window-chrome-icon"
            src="/app-icon.png"
            alt=""
            width={16}
            height={16}
            draggable={false}
          />
          <span className="window-chrome-title">{titleText}</span>
        </div>
        {(onCheckUpdate || onUpdateClick) && (
          <button
            type="button"
            className={
              "window-chrome-update" +
              (updateAvailable ? " is-update" : "") +
              (updateBusy ? " is-busy" : "")
            }
            disabled={updateBusy}
            aria-label={
              updateAvailable
                ? "有新版本可用"
                : "检查更新"
            }
            title={
              updateAvailable
                ? "有新版本，点击查看"
                : "检查是否有更新"
            }
            onClick={() => {
              if (updateAvailable) onUpdateClick?.();
              else onCheckUpdate?.();
            }}
          >
            {updateAvailable ? <IconArrowUp /> : <IconRefresh />}
          </button>
        )}
      </div>
      <div
        className="window-chrome-drag window-chrome-drag-fill"
        data-tauri-drag-region
        onDoubleClick={() => {
          void (async () => {
            await getCurrentWindow().toggleMaximize();
            await refreshMaximized();
          })();
        }}
      />
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
