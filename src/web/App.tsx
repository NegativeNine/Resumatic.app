import { useEffect, useState } from "react";

type ApiState = "checking" | "up" | "down";

/** M0 shell: proves the app and the API are served together. */
export function App() {
  const [api, setApi] = useState<ApiState>("checking");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body: { ok?: boolean }) => !cancelled && setApi(body.ok ? "up" : "down"))
      .catch(() => !cancelled && setApi("down"));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "4rem auto", padding: "0 1rem" }}>
      <h1>Resumatic</h1>
      <p>Resumes tailored to each job from facts you have confirmed, and nothing else.</p>
      <p>
        API: <strong>{api}</strong>
      </p>
    </main>
  );
}
