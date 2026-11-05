interface Props {
  folderName: string;
  progress: number;
  label: string;
  fromCache?: boolean;
  wallpaperUrl?: string | null;
  wallpaperKind?: "image" | "video" | "none";
}

export function LoadingScreen({
  folderName,
  progress,
  label,
  fromCache = false,
  wallpaperUrl,
  wallpaperKind = "none",
}: Props) {
  const pct = Math.max(0, Math.min(100, progress));

  return (
    <div className="boot-screen" role="status" aria-live="polite">
      <div className="boot-wallpaper" aria-hidden>
        {wallpaperKind === "video" && wallpaperUrl ? (
          <video
            className="boot-media boot-video"
            src={wallpaperUrl}
            autoPlay
            muted
            loop
            playsInline
          />
        ) : wallpaperKind === "image" && wallpaperUrl ? (
          <img className="boot-media boot-image" src={wallpaperUrl} alt="" />
        ) : (
          <div className="boot-fallback" />
        )}
        <div className="boot-scrim" />
      </div>

      <div className="boot-progress-track" aria-hidden>
        <div className="boot-progress-fill" style={{ width: `${pct}%` }} />
        <div className="boot-progress-glow" style={{ left: `${pct}%` }} />
      </div>

      <div className="boot-center">
        <img className="boot-mark" src="/app-icon.png" alt="" width={72} height={72} />
        <p className="boot-brand">青枝</p>
        <h2 className="boot-title">{folderName}</h2>
        <p className="boot-label">
          {label}
          {fromCache ? " · 缓存加速" : ""}
        </p>
        <p className="boot-percent">{Math.round(pct)}%</p>
      </div>
    </div>
  );
}
