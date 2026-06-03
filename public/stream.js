export const STREAM_AWARENESS_TIMEOUT_MS = 45_000;

let memoryToken = "";

export function apiAuthHeaders() {
  let token = memoryToken;
  try {
    token = localStorage.getItem("piWebToken") || token;
  } catch {
    // Use the in-memory token captured from the URL hash when storage is unavailable.
  }
  return token ? { "x-pi-web-token": token } : {};
}

export function installApiTokenFromHash() {
  const params = new URLSearchParams(location.hash.startsWith("#") ? location.hash.slice(1) : location.hash);
  const token = params.get("token");
  if (!token) return;
  memoryToken = token;
  try {
    localStorage.setItem("piWebToken", token);
  } catch {
    // Keep memoryToken for this page load and still remove the token from the URL.
  }
  params.delete("token");
  const nextHash = params.toString();
  history.replaceState(null, "", `${location.pathname}${location.search}${nextHash ? `#${nextHash}` : ""}`);
}

export async function readNdjsonStream(res, onEvent) {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      onEvent(evt);
    }
  }
  if (buf.trim()) {
    try {
      onEvent(JSON.parse(buf));
    } catch {
      // Ignore a partial trailing line from an interrupted stream.
    }
  }
}
