import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useResource, type Resource } from "../../src/web/hooks";
import { SessionContext, type Session } from "../../src/web/session";

/** Exercises the real hook in a browser using stable and out-of-order values. */
export async function checkResourceReload(): Promise<boolean> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const stable = { value: "unchanged" };
  let current: Resource<typeof stable> | undefined;
  let load = async () => stable;
  let rerender!: () => void;
  let mounted = true;
  const session = { me: {}, updateMe() {}, async refreshMe() {}, endSession() {} } as unknown as Session;
  function Fixture() {
    const resource = useResource(() => load());
    const [, setOther] = useState(0);
    rerender = () => setOther((n) => n + 1);
    useEffect(() => { current = resource; });
    return <span>{resource.data?.value}</span>;
  }
  const waitFor = async (test: () => boolean) => {
    for (let i = 0; i < 100; i++) {
      if (test()) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  };
  const settled = async (promise: Promise<unknown>) => Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
  ]);
  try {
    root.render(<SessionContext.Provider value={session}><Fixture /></SessionContext.Provider>);
    if (!await waitFor(() => current?.data === stable)) return false;
    // Same reference deliberately produces no React data-state change.
    const unchanged = current!.reload().then((value) => value === stable && host.textContent === "unchanged");
    if (!await settled(unchanged) || !await unchanged) return false;
    let finishDelayed!: (value: typeof stable) => void;
    load = () => new Promise((resolve) => { finishDelayed = resolve; });
    let completed = false;
    const delayed = current!.reload().then((value) => { completed = true; return value; });
    rerender();
    await new Promise((resolve) => setTimeout(resolve, 40));
    if (completed) return false;
    const delayedValue = { value: "delayed" };
    finishDelayed(delayedValue);
    if (!await settled(delayed) || await delayed !== delayedValue || host.textContent !== "delayed") return false;
    let finishOld!: (value: typeof stable) => void;
    load = () => new Promise((resolve) => { finishOld = resolve; });
    const old = current!.reload();
    const next = { value: "newest" };
    load = async () => next;
    if (!await settled(current!.reload())) return false;
    finishOld({ value: "outdated" });
    if (await old !== undefined) return false;
    if (current?.data !== next || host.textContent !== "newest") return false;
    let finishUnmount!: (value: typeof stable) => void;
    load = () => new Promise((resolve) => { finishUnmount = resolve; });
    const unmounted = current!.reload();
    root.unmount();
    mounted = false;
    finishUnmount({ value: "after unmount" });
    return await settled(unmounted) && await unmounted === undefined;
  } finally {
    if (mounted) root.unmount();
    host.remove();
  }
}
