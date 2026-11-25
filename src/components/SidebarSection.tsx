import { useEffect, useState, type ReactNode } from "react";

interface Props {
  title: string;
  /** Count badge next to title (e.g. branch count). */
  count?: number;
  /** Stable id for remembering collapse state. */
  sectionId: string;
  /** Default collapsed on first visit. */
  defaultCollapsed?: boolean;
  stickyTop?: string;
  /** Extra actions on the header (shown when expanded, or always if alwaysShowActions). */
  actions?: ReactNode;
  alwaysShowActions?: boolean;
  /** Hint text on the right when collapsed/expanded. */
  hint?: string;
  children: ReactNode;
}

function collapseKey(sectionId: string) {
  return `gittool.collapse.${sectionId}`;
}

function loadCollapsed(sectionId: string, fallback: boolean): boolean {
  try {
    const raw = sessionStorage.getItem(collapseKey(sectionId));
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    /* ignore */
  }
  return fallback;
}

function saveCollapsed(sectionId: string, collapsed: boolean) {
  try {
    sessionStorage.setItem(collapseKey(sectionId), collapsed ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function SidebarSection({
  title,
  count,
  sectionId,
  defaultCollapsed = false,
  stickyTop = "0",
  actions,
  alwaysShowActions = false,
  hint,
  children,
}: Props) {
  const [collapsed, setCollapsed] = useState(() =>
    loadCollapsed(sectionId, defaultCollapsed),
  );

  useEffect(() => {
    saveCollapsed(sectionId, collapsed);
  }, [sectionId, collapsed]);

  return (
    <div className={`change-group side-section${collapsed ? " is-collapsed" : ""}`}>
      <div
        className="group-header sticky-group-header side-section-header"
        style={{ top: stickyTop }}
      >
        <button
          type="button"
          className="group-toggle"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          title={collapsed ? "展开" : "收起"}
        >
          <span className="group-chevron" aria-hidden>
            {collapsed ? "▸" : "▾"}
          </span>
          <span className="side-section-title">
            {title}
            {typeof count === "number" ? (
              <em className="side-section-count">{count}</em>
            ) : null}
          </span>
        </button>
        <div className="side-section-trail">
          {hint && collapsed ? (
            <span className="muted small side-section-hint">{hint}</span>
          ) : null}
          {actions && (!collapsed || alwaysShowActions) ? (
            <div className="row-actions side-section-actions">{actions}</div>
          ) : null}
        </div>
      </div>
      {!collapsed && <div className="side-section-body">{children}</div>}
    </div>
  );
}
