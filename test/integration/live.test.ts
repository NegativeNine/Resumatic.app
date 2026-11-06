import { afterEach, beforeEach, expect, it } from "vitest";
import { setModels } from "../../src/ai/models";
import { fakeModels, signIn, RESUME, ORIGIN, waitForSource } from "./support";
beforeEach(() => setModels(() => fakeModels()));
afterEach(() => setModels(null));
it("requires a same-origin session for live progress and closes it on sign-out everywhere", async () => {
  const user = await signIn();
  const denied = await user.fetch("/api/live", {
    headers: { upgrade: "websocket", origin: "https://other.test" },
  });
  expect(denied.status).toBe(403);
  const response = await user.fetch("/api/live", {
    headers: { upgrade: "websocket", origin: ORIGIN },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const frame = new Promise<string>((resolve) =>
    socket.addEventListener("message", (event) => resolve(String(event.data)), {
      once: true,
    }),
  );
  const uploaded = await user.upload("resume.pdf", RESUME);
  expect(uploaded.status).toBe(201);
  const events = JSON.parse(await frame);
  expect(events[0]).toMatchObject({ type: "source" });
  expect(Object.keys(events[0]).sort()).toEqual(["id", "type"]);
  const { sourceId } = (await uploaded.json()) as { sourceId: string };
  await waitForSource(user, sourceId);
  const closed = new Promise<number>((resolve) =>
    socket.addEventListener("close", (event) => resolve(event.code), {
      once: true,
    }),
  );
  expect(
    (await user.send("POST", "/api/account/sign-out-everywhere")).status,
  ).toBe(204);
  expect(await closed).toBe(1008);
});
