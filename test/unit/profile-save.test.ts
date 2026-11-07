import { describe, expect, it } from "vitest";
import { isProfileSnapshot, profileWriteObserved } from "../../src/web/profile-save";

const submission = { name: "Avery", email: "a@example.test", phone: "1", location: "Boston", links: ["one", "two"] };
describe("profile save recovery", () => {
  it("accepts only the exact submitted values at the next revision", () => {
    expect(profileWriteObserved({ ...submission, revision: 4 }, 3, submission)).toBe(true);
    expect(profileWriteObserved({ ...submission, revision: 3 }, 3, submission)).toBe(false);
    expect(profileWriteObserved({ ...submission, revision: 5 }, 3, submission)).toBe(false);
    expect(profileWriteObserved({ ...submission, revision: 4, name: "Other" }, 3, submission)).toBe(false);
    expect(profileWriteObserved({ ...submission, revision: 4, links: ["two", "one"] }, 3, submission)).toBe(false);
    expect(profileWriteObserved(undefined, 3, submission)).toBe(false);
    expect(profileWriteObserved({ ...submission, revision: 4 }, undefined, submission)).toBe(false);
  });
  it("rejects an incomplete reload before it can replace the draft", () => {
    expect(isProfileSnapshot({ ...submission, revision: 2 })).toBe(true);
    expect(isProfileSnapshot({ ...submission, revision: 2, links: [1] })).toBe(false);
    expect(isProfileSnapshot({ ...submission, revision: 2, name: null })).toBe(false);
    expect(isProfileSnapshot({ ...submission, revision: 0 })).toBe(false);
  });
});
