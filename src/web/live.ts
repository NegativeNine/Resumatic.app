import { useEffect } from "react";
export const VAULT_CHANGED = "resumatic:vault-change";
/** Sent shortly after this tab changes something through the API, so the header's counts are read again. */
export { COUNTS_CHANGED } from "./api";
/** Push accelerates refresh. Existing polling remains the recovery path for missed events. */
export function useLiveProgress(): void {
  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | undefined;
    let reconnect = 0;
    let heartbeat = 0;
    let notify = 0;
    let delay = 1000;
    const connect = () => {
      if (stopped) return;
      const url = new URL("/api/live", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);
      socket.onopen = () => {
        delay = 1000;
        heartbeat = window.setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
        }, 30000);
      };
      socket.onmessage = (message) => {
        if (message.data === "pong") return;
        try {
          const events = JSON.parse(String(message.data));
          if (!Array.isArray(events) || events.length > 100) return;
          if (!notify)
            notify = window.setTimeout(() => {
              notify = 0;
              window.dispatchEvent(new Event(VAULT_CHANGED));
            }, 150);
        } catch {
          /* Polling handles invalid frames. */
        }
      };
      socket.onclose = (event) => {
        window.clearInterval(heartbeat);
        if (!stopped && event.code !== 1008) {
          reconnect = window.setTimeout(connect, delay);
          delay = Math.min(delay * 2, 30000);
        }
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(reconnect);
      window.clearTimeout(notify);
      window.clearInterval(heartbeat);
      socket?.close();
    };
  }, []);
}
