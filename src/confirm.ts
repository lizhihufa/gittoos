import { ask } from "@tauri-apps/plugin-dialog";

/** Native confirm often fails silently in Tauri WebView; use the dialog plugin. */
export async function confirmAction(
  message: string,
  title = "请确认",
): Promise<boolean> {
  try {
    return await ask(message, { title, kind: "warning" });
  } catch {
    // Fallback if dialog plugin fails for any reason.
    return window.confirm(message);
  }
}

/** Fire-and-forget confirm then run callback. */
export function withConfirm(
  message: string,
  then: () => void,
  title = "请确认",
): void {
  void confirmAction(message, title).then((ok) => {
    if (ok) then();
  });
}
