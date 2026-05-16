export function uiMountPath(): "" | "/ui" {
  const path = window.location.pathname;
  return path === "/ui" || path.startsWith("/ui/") ? "/ui" : "";
}

export function uiPath(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${uiMountPath()}${normalized}`;
}
