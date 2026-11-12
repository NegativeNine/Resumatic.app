import { vi } from "vitest";
import type { DocumentView } from "../../src/shared/documents";
import type { PostingRead } from "../../src/shared/postings";
import type { CardPreview } from "../../src/shared/card";
import { normalizePosting, type FactPatch, type NewFact, type NewRole, type Profile, type ReviewRequest, type RolePatch, type SensitiveRequest } from "../../src/shared/api";
import { PREFERENCES_CHANGED, PREFERENCES_REFUSED, cleanPreferences, type Preferences, type PreferencesUpdate } from "../../src/shared/preferences";
import { EMAIL_OFF, NOTICE_KINDS, type EmailNotices, type NoticeKind } from "../../src/shared/email-notices";
import { normalizePastedText, pasteFilename, type PasteSourceRequest } from "../../src/shared/paste";
import {
  KIT_CHANGED,
  KIT_PROBLEMS,
  REFUSED_KIND_SENTENCE,
  SAVED_ANSWER_CHANGED,
  SAVED_ANSWER_LABEL_TAKEN,
  SAVED_ANSWER_REFUSED,
  answerKey,
  classifyDeterministic,
  cleanKitAnswer,
  cleanKitQuestions,
  cleanSavedAnswerInput,
  refusedKind,
  type KitAnswerChange,
  type KitPart,
  type KitProblem,
  type KitQuestionView,
  type KitView,
  type SavedAnswer,
} from "../../src/shared/kit";
import { wording } from "../../src/shared/record";
import { targetText, type NewShareComment, type NewSuggestion, type ShareComment } from "../../src/shared/sharing";
import { countByState } from "../../src/shared/review-groups";
import { emptyStanding, emptyToday, type Today, type TodayStanding } from "../../src/shared/today";
import { sharedView, type Fixtures } from "./fixtures";

export interface Call {
  method: string;
  /** Path and query, such as "/api/facts?state=proposed". */
  path: string;
  body: unknown;
  /** The Idempotency-Key header, when the request sent one. */
  key?: string;
}

type Reply = { status: number; body?: unknown };
type Handler = (call: Call, params: string[]) => Reply;

/**
 * An in-memory stand-in for the Worker's API, installed as the global fetch. It follows the vault's
 * rules where the UI depends on them: confirming a fact confirms its proposed role, rejecting a role
 * rejects its proposed facts, and facts and roles a person adds start confirmed.
 */
export class FakeApi {
  readonly calls: Call[] = [];
  private failures: { method: string; path: RegExp; reply: Reply; once: boolean }[] = [];
  private seq = 0;

  constructor(readonly state: Fixtures) {}

  /** The account's session is from before the sign-in address was carried. */
  coachNeedsSignIn = false;

  /** Documents written before their evidence was kept, which can't go into a copy. */
  readonly unshareable = new Set<string>();

  /** Documents that use a fact marked sensitive, which can't go into a copy while it is marked. */
  readonly usesSensitive = new Set<string>();

  /** What reading each link comes to. A link that isn't here can't be reached. */
  readonly pages = new Map<string, PostingRead>();

  /** Request keys whose paste was reserved too long ago: replaying one is refused as the Vault refuses it. */
  readonly expiredPasteKeys = new Set<string>();

  /** The text of every paste so far, cleaned as the Worker stores it: the same text again is a second copy. */
  private readonly pasted = new Set<string>();

  /** Whole postings, which the list of jobs doesn't carry. A fixture job's is its excerpt. */
  private readonly postings = new Map<string, string>();
  private posting(id: string): string {
    return this.postings.get(id) ?? this.state.applications.find((a) => a.id === id)?.excerpt ?? "";
  }

  /** Answers the next matching request (or every one, with once: false) with an error. */
  fail(method: string, path: RegExp, status: number, error: string, message: string, once = true): void {
    this.failures.push({ method, path, reply: { status, body: { error, message } }, once });
  }

  /** Calls made with this method to paths that match. */
  callsTo(method: string, path: RegExp): Call[] {
    return this.calls.filter((c) => c.method === method && path.test(c.path));
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : (init?.body ?? null);
    const key = (init?.headers as Record<string, string> | undefined)?.["idempotency-key"];
    const call: Call = { method, path: url.pathname + url.search, body, ...(key ? { key } : {}) };
    this.calls.push(call);

    const failure = this.failures.find((f) => f.method === method && f.path.test(url.pathname));
    if (failure) {
      if (failure.once) this.failures.splice(this.failures.indexOf(failure), 1);
      return respond(failure.reply);
    }
    for (const [routeMethod, pattern, handler] of this.routes) {
      const match = routeMethod === method ? pattern.exec(url.pathname) : null;
      if (match) return respond(handler(call, match.slice(1).map(decodeURIComponent)));
    }
    return respond({ status: 404, body: { error: "not_found", message: "no such route" } });
  };

  /** Where a suggestion on the owner's side stands, by its ID: the object itself, for a route to change. */
  private suggestion(id: string) {
    return (this.state.shareComments ?? []).flatMap((thread) => thread.comments).find((comment) => comment.id === id)?.suggestion;
  }

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}-new-${this.seq}`;
  }

  private readonly routes: [string, RegExp, Handler][] = [
    ["GET", /^\/api\/me$/, () => ok(this.state.me)],
    ["GET", /^\/api\/v2\/vault$/, () => ok({ sources: this.state.sources, roles: this.state.roles, facts: this.state.facts })],
    ["GET", /^\/api\/billing$/, () => ok(this.state.billing ?? { enabled: false, plans: [], current: null })],
    ["GET", /^\/api\/shares$/, () => ok({ grants: this.state.shares ?? [] })],
    ["GET", /^\/api\/coach\/clients$/, () => ok({ clients: this.state.clients ?? [], needsSignIn: this.coachNeedsSignIn })],
    ["POST", /^\/api\/coach\/clients\/([^/]+)\/open$/, (_call, [grantId]) => ok({ grantId })],
    [
      "DELETE",
      /^\/api\/coach\/clients\/([^/]+)$/,
      (_call, [grantId]) => {
        this.state.clients = (this.state.clients ?? []).filter((client) => client.grantId !== grantId);
        return { status: 204 };
      },
    ],
    // A coach's comments on the copy they are reading. The copy is the one sharedView() gives.
    ["GET", /^\/api\/coach\/clients\/([^/]+)\/comments$/, () => ok({ threads: this.state.coachComments ?? [] })],
    [
      "POST",
      /^\/api\/coach\/clients\/([^/]+)\/comments$/,
      (call) => {
        const { target, body } = call.body as NewShareComment;
        const made: ShareComment = { id: this.id("comment"), author: "coach", body: body.trim(), createdAt: Date.now() };
        const threads = (this.state.coachComments ??= []);
        const thread = threads.find((held) => JSON.stringify(held.target) === JSON.stringify(target));
        if (thread) thread.comments.push(made);
        else threads.push({ target, quote: targetText(sharedView().snapshot, target) ?? "", comments: [made] });
        return { status: 201, body: made };
      },
    ],
    [
      "POST",
      /^\/api\/coach\/clients\/([^/]+)\/suggestions$/,
      (call) => {
        // As the vault does: one waiting on a line for this account, and nothing changed until the owner accepts.
        const { target, text } = call.body as NewSuggestion;
        const threads = (this.state.coachComments ??= []);
        const thread = threads.find((held) => JSON.stringify(held.target) === JSON.stringify(target));
        if (thread?.comments.some((comment) => comment.suggestion?.state === "waiting"))
          return { status: 409, body: { error: "conflict", message: "You already have a suggestion waiting on this line. Delete it to suggest another." } };
        const made: ShareComment = { id: this.id("suggestion"), author: "coach", body: text.trim(), createdAt: Date.now(), suggestion: { state: "waiting" } };
        if (thread) thread.comments.push(made);
        else threads.push({ target, quote: targetText(sharedView().snapshot, target) ?? "", comments: [made] });
        return { status: 201, body: made };
      },
    ],
    [
      "DELETE",
      /^\/api\/coach\/clients\/([^/]+)\/comments\/([^/]+)$/,
      (_call, [, id]) => {
        // As the vault does: only the coach's own, and a thread with nothing left in it is gone.
        this.state.coachComments = (this.state.coachComments ?? [])
          .map((thread) => ({ ...thread, comments: thread.comments.filter((comment) => comment.id !== id || comment.author !== "coach") }))
          .filter((thread) => thread.comments.length > 0);
        return { status: 204 };
      },
    ],
    [
      "GET",
      /^\/api\/documents$/,
      () =>
        ok({
          documents: (this.state.documents ?? [])
            .filter((doc) => doc.state === "ready" && (doc.kind === "letter" || doc.kind === "prep"))
            .map((doc) => ({
              id: doc.id, kind: doc.kind, applicationId: doc.applicationId, version: doc.version, createdAt: doc.createdAt,
              shareable: !this.unshareable.has(doc.id) && !this.usesSensitive.has(doc.id),
              ...(this.usesSensitive.has(doc.id) && !this.unshareable.has(doc.id) ? { usesSensitive: true } : {}),
            })),
        }),
    ],
    [
      "POST",
      /^\/api\/shares$/,
      (call) => {
        const { factIds, resumes, documents, expiresAt, label, coachEmail } = call.body as { factIds: string[]; resumes: unknown[]; documents?: unknown[]; expiresAt: number; label?: string; coachEmail?: string };
        const grant = {
          id: this.id("share"), epoch: "e", createdAt: Date.now(), expiresAt, revokedAt: null,
          factCount: factIds.length, resumeCount: resumes.length, documentCount: documents?.length ?? 0, available: true, label: label ?? null, lastReadAt: null,
          coach: coachEmail ? { email: coachEmail.toLowerCase(), name: null, joinedAt: null } : null,
        };
        (this.state.shares ??= []).unshift(grant);
        return { status: 201, body: { grant, url: `https://resumatic.test/share#synthetic-${grant.id}` } };
      },
    ],
    // What coaches wrote on the copies this account shared, and its replies.
    ["GET", /^\/api\/shares\/comments$/, () => ok({ threads: this.state.shareComments ?? [] })],
    [
      "POST",
      /^\/api\/v2\/shares\/comments\/seen$/,
      (call) => {
        // Only the comments the page names, as the vault does. The count is of what is left.
        const ids = new Set((call.body as { ids: string[] }).ids);
        const coaches = (this.state.shareComments ?? []).flatMap((thread) => thread.comments).filter((comment) => comment.author === "coach");
        for (const comment of coaches) if (ids.has(comment.id)) comment.seen = true;
        this.state.me.newFromCoach = coaches.filter((comment) => comment.seen === false).length;
        return { status: 204 };
      },
    ],
    [
      "POST",
      /^\/api\/shares\/comments\/([^/]+)\/replies$/,
      (call, [id]) => {
        const thread = (this.state.shareComments ?? []).find((held) => held.comments.some((comment) => comment.id === id && comment.author === "coach"));
        if (!thread) return notFound("that comment has been deleted; reload to see the thread as it stands");
        if (!thread.open)
          return { status: 409, body: { error: "conflict", message: "this copy isn't open to your coach any more, so they can't read a reply; share a new copy to carry on" } };
        const made: ShareComment = { id: this.id("reply"), author: "owner", body: (call.body as { body: string }).body.trim(), createdAt: Date.now() };
        thread.comments.push(made);
        return { status: 201, body: made };
      },
    ],
    // A coach's suggested wording, which the owner accepts as a check of their own or declines.
    [
      "POST",
      /^\/api\/shares\/suggestions\/([^/]+)\/accept$/,
      (_call, [id]) => {
        const suggestion = this.suggestion(id!);
        if (!suggestion) return notFound("That suggestion has been deleted. Reload to see the thread as it stands.");
        const started = { status: 202, body: { documentId: `document-for-${id}`, runId: `document-for-${id}` } };
        if (["checking", "applied", "not_applied"].includes(suggestion.state)) return started;
        if (suggestion.state === "declined") return conflict("You've already answered this suggestion.");
        if (suggestion.state === "stale") return conflict("This line has changed since the copy was made, so this suggestion can't be applied.");
        const { used, limit } = this.state.me.quota;
        if (used >= limit) return { status: 429, body: { error: "quota", message: "no outputs are left" } };
        suggestion.state = "checking";
        delete suggestion.lastCheck;
        return started;
      },
    ],
    [
      "POST",
      /^\/api\/shares\/suggestions\/([^/]+)\/decline$/,
      (_call, [id]) => {
        const suggestion = this.suggestion(id!);
        if (!suggestion) return notFound("That suggestion has been deleted. Reload to see the thread as it stands.");
        if (suggestion.state === "checking") return conflict("This suggestion is being checked. Wait for the check to finish, then try again.");
        if (suggestion.state === "applied" || suggestion.state === "not_applied") return conflict("You've already answered this suggestion.");
        suggestion.state = "declined";
        delete suggestion.lastCheck;
        return { status: 204 };
      },
    ],
    [
      "DELETE",
      /^\/api\/shares\/comments\/([^/]+)$/,
      (_call, [id]) => {
        if (this.suggestion(id!)?.state === "checking") return conflict("This suggestion is being checked. Wait for the check to finish, then try again.");
        this.state.shareComments = (this.state.shareComments ?? [])
          .map((thread) => ({ ...thread, comments: thread.comments.filter((comment) => comment.id !== id) }))
          .filter((thread) => thread.comments.length > 0);
        return { status: 204 };
      },
    ],
    ["GET", /^\/api\/mcp\/grants$/, () => ok({ grants: this.state.mcpGrants ?? [] })],
    [
      "GET",
      /^\/api\/applications\/([^/]+)\/documents$/,
      (_call, [id]) => ok({ documents: (this.state.documents ?? []).filter((doc) => doc.applicationId === id) }),
    ],
    [
      "POST",
      /^\/api\/applications\/([^/]+)\/documents$/,
      (call, [applicationId]) => {
        const { kind } = call.body as { kind: DocumentView["kind"] };
        const id = this.id("doc");
        const covering = this.state.facts.filter((fact) => fact.state === "confirmed").slice(0, 2);
        // Only a fit preview is finished at once here: it is the one kind these tests start.
        const fit = kind === "fit";
        (this.state.documents ??= []).unshift({
          id, applicationId, kind, state: fit ? "ready" : "running", version: 1, createdAt: Date.now(), error: null,
          result: fit
            ? {
                kind, units: [], questions: [], report: { kept: 0, repaired: 0, replaced: 0, dropped: 0, gaps: ["Terraform"] },
                fit: { requirements: [{ text: "Kubernetes in production", factIds: covering.map((fact) => fact.id) }, { text: "Terraform", factIds: [] }] },
              }
            : null,
          facts: Object.fromEntries(covering.map((fact) => [fact.id, { text: fact.text, quote: fact.quote ?? null }])),
        });
        return { status: 202, body: { documentId: id, runId: id } };
      },
    ],
    [
      "GET",
      /^\/api\/resumes\/([^/]+)\/versions$/,
      (_call, [id]) => {
        const resume = this.state.resumes[id];
        return resume ? ok({ versions: [{ version: resume.version, createdAt: resume.createdAt }] }) : notFound("no such resume");
      },
    ],
    ["GET", /^\/api\/profile$/, () => ok(this.state.me.profile)],
    [
      "PUT",
      /^\/api\/(?:v2\/)?profile$/,
      (call) => {
        const { expectedRevision: _revision, ...patch } = call.body as Partial<Profile> & { expectedRevision?: number };
        this.state.me.profile = { ...this.state.me.profile, ...patch, revision: (this.state.me.profile.revision ?? 0) + 1 };
        return ok(this.state.me.profile);
      },
    ],
    ["GET", /^\/api\/preferences$/, () => ok(this.state.preferences ?? NOTHING_SAID)],
    [
      "PUT",
      /^\/api\/preferences$/,
      (call) => {
        // As the server does: the one rule decides what a save takes, and it lands only at the saved revision.
        const { expectedRevision, ...values } = call.body as PreferencesUpdate;
        const clean = cleanPreferences(values);
        if (!clean) return { status: 422, body: { error: "invalid", message: PREFERENCES_REFUSED } };
        const saved = this.state.preferences ?? NOTHING_SAID;
        if (expectedRevision !== saved.revision) return { status: 409, body: { error: "conflict", message: PREFERENCES_CHANGED } };
        this.state.preferences = { ...clean, revision: saved.revision + 1, updatedAt: Date.now() };
        return ok(this.state.preferences);
      },
    ],
    ["GET", /^\/api\/v2\/card-preview$/, () => ok(this.state.cardPreview ?? EMPTY_CARD)],
    // Email notices, as the server answers: 503 where the deployment sends none, an address only
    // from the session, and a kind turned on only by a session that has one.
    ["GET", /^\/api\/email-notices$/, () => (this.state.me.capabilities?.emailNotices ? ok(this.notices()) : EMAIL_UNAVAILABLE)],
    [
      "PUT",
      /^\/api\/email-notices\/([^/]+)$/,
      (call, [kind]) => {
        if (!this.state.me.capabilities?.emailNotices) return EMAIL_UNAVAILABLE;
        const on = (call.body as { on?: unknown } | undefined)?.on;
        if (!(NOTICE_KINDS as readonly string[]).includes(kind!) || typeof on !== "boolean")
          return { status: 422, body: { error: "invalid", message: "choose a notice to turn on or off" } };
        const current = this.notices();
        if (on && !current.address) return conflict("sign out and in again to turn on email notices");
        this.state.emailNotices = { ...current, [kind as NoticeKind]: on };
        return ok(this.state.emailNotices);
      },
    ],
    // Saved answers and application kits, by the same rules the vault keeps: the closed list,
    // matching a label word for word, revisions, and every write making the kit a draft. There is
    // no judge here.
    ["GET", /^\/api\/saved-answers$/, () => ok({ savedAnswers: this.state.savedAnswers ?? [] })],
    ["POST", /^\/api\/saved-answers$/, (call) => this.addSaved(call.body)],
    [
      "PUT",
      /^\/api\/saved-answers\/([^/]+)$/,
      (call, [id]) => {
        const saved = (this.state.savedAnswers ?? []).find((answer) => answer.id === id);
        if (!saved) return notFound("no such saved answer");
        const { expectedRevision, ...input } = call.body as { label: string; answer: string; expectedRevision: number };
        const clean = cleanSavedAnswerInput(input);
        if (!clean) return invalid(SAVED_ANSWER_REFUSED);
        const kind = refusedKind(clean.label) ?? refusedKind(clean.answer);
        if (kind) return invalid(REFUSED_KIND_SENTENCE[kind]);
        if (expectedRevision !== saved.revision) return conflict(SAVED_ANSWER_CHANGED);
        Object.assign(saved, clean, { revision: saved.revision + 1, updatedAt: Date.now() });
        for (const kit of Object.values(this.state.kits ?? {})) if (kit.questions.some((question) => question.savedAnswer?.id === id)) this.touchKit(kit);
        return ok(saved);
      },
    ],
    [
      "DELETE",
      /^\/api\/saved-answers\/([^/]+)$/,
      (_call, [id]) => {
        if (!(this.state.savedAnswers ?? []).some((answer) => answer.id === id)) return notFound("no such saved answer");
        this.state.savedAnswers = (this.state.savedAnswers ?? []).filter((answer) => answer.id !== id);
        for (const kit of Object.values(this.state.kits ?? {})) {
          if (!kit.questions.some((question) => question.savedAnswer?.id === id)) continue;
          for (const question of kit.questions)
            if (question.savedAnswer?.id === id) Object.assign(question, { state: "asks", matchedBy: null, savedAnswer: null, confirmed: false });
          this.touchKit(kit);
        }
        return { status: 204 };
      },
    ],
    ["GET", /^\/api\/applications\/([^/]+)\/kit$/, (_call, [id]) => ok(this.kit(id!))],
    [
      "PUT",
      /^\/api\/applications\/([^/]+)\/kit\/questions$/,
      (call, [id]) => {
        const kit = this.kit(id!);
        const { questions, expectedRevision } = call.body as { questions: unknown; expectedRevision: number };
        const submitted = cleanKitQuestions(questions);
        if (!submitted) return invalid("These questions couldn't be saved as written. Keep to 30 questions of up to 1,000 characters each, then save again.");
        if (expectedRevision !== kit.revision) return conflict(KIT_CHANGED);
        const usable = (this.state.savedAnswers ?? []).filter((answer) => !answer.refusedKind).map((answer) => ({ id: answer.id, labelKey: answerKey(answer.label) }));
        kit.questions = submitted.map((question, position): KitQuestionView => {
          const was = kit.questions.find((held) => held.id === question.id);
          if (was && was.text === question.text) return { ...was, position };
          const decided = classifyDeterministic(question.text, usable);
          const savedAnswer = decided?.state === "matched" ? (this.state.savedAnswers ?? []).find((answer) => answer.id === decided.savedAnswerId)! : null;
          return {
            id: question.id ?? this.id("question"),
            position,
            text: question.text,
            state: decided?.state ?? "asks",
            matchedBy: savedAnswer ? "label" : null,
            savedAnswer,
            confirmed: false,
            sensitiveKind: decided?.state === "sensitive" ? decided.kind : null,
            typedAnswer: null,
          };
        });
        return ok(this.touchKit(kit));
      },
    ],
    [
      "PUT",
      /^\/api\/applications\/([^/]+)\/kit\/parts$/,
      (call, [id]) => {
        const kit = this.kit(id!);
        const { resume, letter, prep, expectedRevision } = call.body as { resume: KitPart | null; letter: KitPart | null; prep: KitPart | null; expectedRevision: number };
        if (expectedRevision !== kit.revision) return conflict(KIT_CHANGED);
        Object.assign(kit, { resume, letter, prep });
        return ok(this.touchKit(kit));
      },
    ],
    [
      "POST",
      /^\/api\/applications\/([^/]+)\/kit\/questions\/([^/]+)$/,
      (call, [id, questionId]) => {
        const kit = this.kit(id!);
        const { change, expectedRevision } = call.body as { change: KitAnswerChange; expectedRevision: number };
        if (expectedRevision !== kit.revision) return conflict(KIT_CHANGED);
        const question = kit.questions.find((held) => held.id === questionId);
        if (!question) return notFound("no such question");
        const savedById = (savedId: string) => (this.state.savedAnswers ?? []).find((answer) => answer.id === savedId);
        switch (change.kind) {
          case "confirm":
            question.confirmed = true;
            break;
          case "reject":
            Object.assign(question, { state: "asks", matchedBy: null, savedAnswer: null, confirmed: false, typedAnswer: null });
            break;
          case "use":
            Object.assign(question, { state: "matched", matchedBy: "owner", savedAnswer: savedById(change.savedAnswerId) ?? null, confirmed: true, typedAnswer: null });
            break;
          case "type": {
            const answer = cleanKitAnswer(change.answer);
            if (!answer) return invalid("This answer couldn't be saved as written. Keep it to 4,000 characters, then save again.");
            question.typedAnswer = answer;
            break;
          }
          case "save": {
            const added = this.addSaved({ label: change.label, answer: change.answer });
            if (added.status >= 400) return added;
            Object.assign(question, { state: "matched", matchedBy: "owner", savedAnswer: added.body, confirmed: true, typedAnswer: null });
            break;
          }
        }
        return ok(this.touchKit(kit));
      },
    ],
    [
      "POST",
      /^\/api\/applications\/([^/]+)\/kit\/approve$/,
      (call, [id]) => {
        const kit = this.kit(id!);
        const { expectedRevision } = call.body as { expectedRevision: number };
        if (expectedRevision !== kit.revision || kit.state === "approved") return conflict(KIT_CHANGED);
        const [problem] = kitProblems(kit);
        if (problem) return { status: problem.code === "no_resume" || problem.code === "unanswered" ? 422 : 409, body: { error: "invalid", message: KIT_PROBLEMS[problem.code].sentence } };
        Object.assign(kit, { state: "approved", approvedAt: Date.now(), revision: kit.revision + 1, ready: true });
        return ok(kit);
      },
    ],
    ["POST", /^\/api\/account\/sign-out-everywhere$/, () => ({ status: 204 })],
    ["POST", /^\/auth\/logout$/, () => ({ status: 204 })],
    ["DELETE", /^\/auth\/account$/, () => ({ status: 202, body: { deleting: true } })],

    ["GET", /^\/api\/sources$/, () => ok({ sources: this.state.sources })],
    [
      "POST",
      /^\/api\/sources$/,
      (call) => {
        const file = call.body instanceof FormData ? call.body.get("file") : null;
        const id = this.id("src");
        const filename = file instanceof File ? file.name : "upload.pdf";
        this.state.sources.unshift({ id, filename, state: "queued", error: null, createdAt: Date.now(), proposed: 0 });
        return { status: 201, body: { sourceId: id } };
      },
    ],
    [
      "POST",
      /^\/api\/sources\/paste$/,
      (call) => {
        const { text, title } = call.body as PasteSourceRequest;
        if (call.key && this.expiredPasteKeys.has(call.key)) return conflict("This text wasn't added. Add it again.");
        const stored = normalizePastedText(text);
        if (this.pasted.has(stored)) return conflict("You've already pasted this text.");
        this.pasted.add(stored);
        const id = this.id("src");
        this.state.sources.unshift({ id, filename: pasteFilename(title) ?? "Pasted text.txt", origin: "paste", state: "queued", error: null, createdAt: Date.now(), proposed: 0 });
        return { status: 201, body: { sourceId: id } };
      },
    ],
    [
      "GET",
      /^\/api\/sources\/([^/]+)\/text$/,
      (_call, [sourceId]) => {
        const markdown = this.state.sourceTexts?.[sourceId];
        if (markdown === undefined) return conflict("this source has not been read yet");
        const origin = this.state.sources.find((s) => s.id === sourceId)?.origin ?? "upload";
        return ok({ markdown, revisionId: `${sourceId}:1`, origin });
      },
    ],

    ["GET", /^\/api\/roles$/, () => ok({ roles: this.state.roles })],
    [
      "POST",
      /^\/api\/(?:v3\/)?roles$/,
      (call) => {
        const role = call.body as NewRole;
        const id = this.id("role");
        this.state.roles.push({ ...role, id, state: "confirmed", quote: null, sourceId: null });
        return { status: 201, body: { roleId: id } };
      },
    ],
    [
      "PATCH",
      /^\/api\/(?:v2\/)?roles\/([^/]+)$/,
      (call, [id]) => {
        const role = this.state.roles.find((r) => r.id === id);
        if (!role) return notFound("no such role");
        const { expectedRevision: _revision, ...patch } = call.body as RolePatch;
        Object.assign(role, patch);
        return { status: 204 };
      },
    ],

    [
      "GET",
      /^\/api\/facts$/,
      (call) => {
        const state = new URL(call.path, "http://localhost").searchParams.get("state");
        return ok({ facts: state ? this.state.facts.filter((f) => f.state === state) : this.state.facts });
      },
    ],
    [
      "POST",
      /^\/api\/(?:v2\/)?facts$/,
      (call) => {
        const fact = call.body as NewFact;
        const id = this.id("fact");
        this.state.facts.unshift({ ...fact, id, origin: "user", state: "confirmed", quote: null, sourceId: null });
        return { status: 201, body: { factId: id } };
      },
    ],
    [
      "PATCH",
      /^\/api\/facts\/([^/]+)$/,
      (call, [id]) => {
        const fact = this.state.facts.find((f) => f.id === id);
        if (!fact) return notFound("no such fact");
        const patch = call.body as FactPatch;
        if (patch.text !== undefined) fact.text = patch.text;
        if (patch.roleId !== undefined) fact.roleId = patch.roleId;
        if (patch.level !== undefined) fact.level = patch.level;
        fact.origin = "user";
        return { status: 204 };
      },
    ],
    [
      "POST",
      /^\/api\/review$/,
      (call) => {
        const { confirm, reject } = call.body as ReviewRequest;
        for (const id of confirm) {
          const role = this.state.roles.find((r) => r.id === id);
          if (role) role.state = "confirmed";
          const fact = this.state.facts.find((f) => f.id === id);
          if (fact) {
            fact.state = "confirmed";
            const parent = this.state.roles.find((r) => r.id === fact.roleId);
            if (parent?.state === "proposed") parent.state = "confirmed";
          }
        }
        for (const id of reject) {
          const role = this.state.roles.find((r) => r.id === id);
          if (role) {
            role.state = "rejected";
            for (const f of this.state.facts) if (f.roleId === id && f.state === "proposed") f.state = "rejected";
          }
          const fact = this.state.facts.find((f) => f.id === id);
          if (fact) fact.state = "rejected";
        }
        this.recountSources();
        return { status: 204 };
      },
    ],
    [
      "POST",
      /^\/api\/facts\/sensitive$/,
      (call) => {
        const { ids, sensitive } = call.body as SensitiveRequest;
        const named = ids.map((id) => this.state.facts.find((fact) => fact.id === id));
        if (named.some((fact) => !fact)) return notFound("no such fact");
        // As the vault does: every fact with the same words is marked or unmarked with the ones named.
        const words = new Set(named.map((fact) => wording(fact!.text)));
        for (const fact of this.state.facts) {
          if (!ids.includes(fact.id) && !words.has(wording(fact.text))) continue;
          if (sensitive) fact.sensitive = true;
          else delete fact.sensitive;
        }
        return { status: 204 };
      },
    ],

    ["GET", /^\/api\/applications$/, () => ok({ applications: this.state.applications })],
    [
      "POST",
      /^\/api\/(?:v2\/)?applications$/,
      (call) => {
        const { jdText, url, title, company } = call.body as { jdText: string; url?: string; title?: string; company?: string };
        const id = this.id("app");
        this.state.applications.push({ id, company: company ?? null, title: title ?? null, excerpt: jdText.slice(0, 100), createdAt: Date.now(), url: url ?? null, revision: 1, resumes: [] });
        this.postings.set(id, jdText);
        return { status: 201, body: { applicationId: id } };
      },
    ],
    [
      "POST",
      /^\/api\/postings\/read$/,
      (call) => ok(this.pages.get((call.body as { url: string }).url) ?? { posting: null, reason: "unreachable" }),
    ],
    [
      "POST",
      /^\/api\/applications\/duplicates$/,
      (call) => {
        const wanted = normalizePosting((call.body as { jdText: string }).jdText);
        const found = this.state.applications.find((a) => normalizePosting(this.posting(a.id)) === wanted);
        return ok({ duplicate: found ? { id: found.id, company: found.company, title: found.title, excerpt: found.excerpt, createdAt: found.createdAt } : null });
      },
    ],
    [
      "GET",
      /^\/api\/applications\/([^/]+)$/,
      (_call, [id]) => {
        const application = this.state.applications.find((a) => a.id === id);
        if (!application) return notFound("no such application");
        return ok({ ...application, jdText: this.posting(id), canDelete: application.resumes.length === 0 });
      },
    ],
    [
      "DELETE",
      /^\/api\/applications\/([^/]+)$/,
      (_call, [id]) => {
        const application = this.state.applications.find((a) => a.id === id);
        if (!application) return notFound("no such application");
        if (application.resumes.length > 0)
          return { status: 409, body: { error: "conflict", message: "This job has resumes or documents, so it can’t be deleted. Mark it Closed instead." } };
        this.state.applications.splice(this.state.applications.indexOf(application), 1);
        return { status: 204 };
      },
    ],
    [
      "PATCH",
      /^\/api\/applications\/([^/]+)$/,
      (call, [id]) => {
        const application = this.state.applications.find((a) => a.id === id);
        if (!application) return notFound("no such application");
        const { expectedRevision: _revision, jdText, ...patch } = call.body as { expectedRevision?: number; jdText?: string; title?: string; company?: string; url?: string };
        if (jdText !== undefined) this.postings.set(id, jdText);
        // As the server does: an empty name or link clears it.
        for (const key of ["title", "company", "url"] as const) if (patch[key] === "") (patch as Record<string, unknown>)[key] = null;
        Object.assign(application, patch, { revision: (application.revision ?? 1) + 1 });
        return { status: 204 };
      },
    ],
    [
      "POST",
      /^\/api\/applications\/([^/]+)\/resumes$/,
      (_call, [applicationId]) => {
        const application = this.state.applications.find((a) => a.id === applicationId);
        if (!application) return notFound("no such application");
        const quota = this.state.me.quota;
        if (quota.used >= quota.limit) {
          return { status: 429, body: { error: "quota", message: `You’ve used all ${quota.limit} tailored resumes for Nov 2026. You can tailor more from 1 Dec 2026.` } };
        }
        quota.used += 1;
        const id = this.id("res");
        const createdAt = Date.now();
        application.resumes.push({ id, state: "running", createdAt });
        this.state.resumes[id] = {
          id,
          applicationId,
          state: "running",
          step: null,
          error: null,
          version: 1,
          createdAt,
          body: null,
          report: null,
          facts: {},
        };
        return { status: 202, body: { resumeId: id } };
      },
    ],
    [
      "GET",
      /^\/api\/resumes\/([^/]+)$/,
      (_call, [id]) => {
        const resume = this.state.resumes[id];
        return resume ? ok(resume) : notFound("no such resume");
      },
    ],
    [
      "POST",
      /^\/api\/resumes\/([^/]+)\/remove-(line|skill)$/,
      (call, [resumeId, what]) => {
        const resume = this.state.resumes[resumeId!];
        if (!resume?.body) return notFound("no such resume");
        const { lineId, skillIndex } = call.body as { lineId?: string; skillIndex?: number };
        // As the vault does: a new version without the line or the skill, and what that version
        // still takes from facts marked sensitive is worked out for it.
        const use = resume.sensitiveUse ?? { lineIds: [], skills: [] };
        if (what === "line") {
          if (resume.body.summary?.id === lineId) resume.body.summary = null;
          resume.body.sections = resume.body.sections.flatMap((section) => {
            const lines = section.lines.filter((line) => line.id !== lineId);
            return lines.length || !section.lines.length ? [{ ...section, lines }] : [];
          });
          use.lineIds = use.lineIds.filter((id) => id !== lineId);
        } else {
          const [skill] = resume.body.skills.splice(skillIndex ?? -1, 1);
          use.skills = use.skills.filter((name) => name !== skill);
        }
        if (use.lineIds.length || use.skills.length) resume.sensitiveUse = use;
        else delete resume.sensitiveUse;
        resume.version += 1;
        return ok({ version: resume.version });
      },
    ],
    [
      "PATCH",
      /^\/api\/resumes\/([^/]+)\/lines\/([^/]+)$/,
      (call, [resumeId, lineId]) => {
        const body = this.state.resumes[resumeId]?.body;
        const line = body && [...(body.summary ? [body.summary] : []), ...body.sections.flatMap((s) => s.lines)].find((l) => l.id === lineId);
        if (!line) return notFound("no such line");
        line.text = (call.body as { text: string }).text;
        line.status = "edited";
        this.state.resumes[resumeId].version += 1;
        return { status: 204 };
      },
    ],

    // The redesign's stages add their routes here, each inside its own block.

    // stage 2: the shell
    // What waits for the owner, as the fixtures give it: nothing at all unless a test says.
    ["GET", /^\/api\/v2\/today$/, () => ok(this.todayReply())],

    // stage 3: today

    // stage 4: facts

    // stage 5: jobs

    // stage 6: sharing and account

    // stage 7: outside
  ];

  // stage 3: today
  /**
   * Today as a test set it, with or without `standing`. Otherwise nothing waits, works or happened,
   * and where things stand is worked out from the record, so adding the first file ends first run.
   */
  private todayReply(): Today {
    if (this.state.today) return this.state.today;
    return { ...emptyToday(0), standing: standingOf(this.state, Date.now()) };
  }

  /** The email notice settings as saved, or every kind off, to the session's address. */
  private notices(): EmailNotices {
    return this.state.emailNotices ?? { comment: false, suggestion: false, reminder: false, status: "ok", address: this.state.me.signInEmail ?? null };
  }

  /** Adds a saved answer as the vault does: the same label and words again returns the one kept. */
  private addSaved(body: unknown): Reply {
    const clean = cleanSavedAnswerInput(body);
    if (!clean) return invalid(SAVED_ANSWER_REFUSED);
    const kind = refusedKind(clean.label) ?? refusedKind(clean.answer);
    if (kind) return invalid(REFUSED_KIND_SENTENCE[kind]);
    const answers = (this.state.savedAnswers ??= []);
    const same = answers.find((answer) => answerKey(answer.label) === answerKey(clean.label));
    if (same) return same.answer === clean.answer ? { status: 201, body: same } : conflict(SAVED_ANSWER_LABEL_TAKEN);
    const now = Date.now();
    const made: SavedAnswer = { id: this.id("saved"), revision: 1, ...clean, refusedKind: null, createdAt: now, updatedAt: now };
    answers.push(made);
    return { status: 201, body: made };
  }

  /** A job's kit as it stands, made at revision 0 with what can be chosen for the job if it has none yet. */
  private kit(applicationId: string): KitView {
    const kits = (this.state.kits ??= {});
    const held = kits[applicationId];
    if (held) return held;
    const job = this.state.applications.find((application) => application.id === applicationId);
    const ready = (this.state.documents ?? []).filter((doc) => doc.applicationId === applicationId && doc.state === "ready");
    const made: KitView = {
      applicationId,
      revision: 0,
      state: "draft",
      approvedAt: null,
      resume: null,
      letter: null,
      prep: null,
      questions: [],
      choices: {
        resumes: (job?.resumes ?? []).filter((resume) => resume.state === "ready").map((resume) => ({ id: resume.id, version: this.state.resumes[resume.id]?.version ?? 1, createdAt: resume.createdAt })),
        letters: ready.filter((doc) => doc.kind === "letter").map((doc) => ({ id: doc.id, version: doc.version ?? 1, createdAt: doc.createdAt })),
        preps: ready.filter((doc) => doc.kind === "prep").map((doc) => ({ id: doc.id, version: doc.version ?? 1, createdAt: doc.createdAt })),
      },
      problems: [],
      ready: false,
      updatedAt: null,
    };
    made.problems = kitProblems(made);
    kits[applicationId] = made;
    return made;
  }

  /** Every write to a kit makes it a draft at its next revision, with its problems worked out again. */
  private touchKit(kit: KitView): KitView {
    Object.assign(kit, { revision: kit.revision + 1, state: "draft", approvedAt: null, ready: false, updatedAt: Date.now() });
    kit.problems = kitProblems(kit);
    return kit;
  }

  /** Keeps SourceView.proposed in step with the facts, as the vault’s query does. */
  private recountSources(): void {
    for (const source of this.state.sources) {
      source.proposed = this.state.facts.filter((f) => f.sourceId === source.id && f.state === "proposed").length;
    }
  }
}

// stage 3: today
/**
 * Where things stand in a record, as the Vault counts it: every file, roles and facts as the review
 * groups them, jobs by status, copies neither revoked nor expired at `now`, and active apps.
 */
export function standingOf(state: Fixtures, now: number): TodayStanding {
  const states = countByState({ roles: state.roles, facts: state.facts });
  const jobs = emptyStanding().jobs;
  for (const application of state.applications) jobs[application.status ?? "saved"] += 1;
  const copies = (state.shares ?? []).filter((share) => share.revokedAt === null && share.expiresAt > now);
  return {
    files: state.sources.length,
    confirmed: states.confirmed,
    leftOut: states.rejected,
    jobs,
    copies: copies.length,
    coachCopies: copies.filter((share) => share.coach).length,
    apps: (state.mcpGrants ?? []).filter((grant) => grant.state === "active" && grant.revokedAt === null && grant.expiresAt > now).length,
  };
}

/** Installs a fake API over the given fixtures as the global fetch, and returns it. */
export function installFakeApi(state: Fixtures): FakeApi {
  const api = new FakeApi(state);
  vi.stubGlobal("fetch", vi.fn(api.fetch));
  return api;
}

const ok = (body: unknown): Reply => ({ status: 200, body });
/** Job preferences before the first save. */
const NOTHING_SAID: Preferences = { revision: 0, place: null, jobTypes: [], availableFrom: null, payFloor: null, updatedAt: null };
/** The card of a vault with no confirmed tags and no confirmed job: every vault today. */
const EMPTY_CARD: CardPreview = { state: "ready", taxonomyVersion: "esco-1.2.1+onet-31.0+3f810824", card: { occupation: null, experience: null, skills: [] } };
const notFound = (message: string): Reply => ({ status: 404, body: { error: "not_found", message } });
const conflict = (message: string): Reply => ({ status: 409, body: { error: "conflict", message } });
const EMAIL_UNAVAILABLE: Reply = { status: 503, body: { error: "unavailable", message: EMAIL_OFF } };
const invalid = (message: string): Reply => ({ status: 422, body: { error: "invalid", message } });

/** What keeps a kit from approval, as the vault reports it: no resume, or a question with no answer typed or checked. */
function kitProblems(kit: KitView): KitProblem[] {
  const problems: KitProblem[] = kit.resume ? [] : [{ code: "no_resume" }];
  const unanswered = kit.questions.filter((question) => (question.state === "matched" ? !question.confirmed : question.typedAnswer === null)).map((question) => question.id);
  if (unanswered.length) problems.push({ code: "unanswered", questionIds: unanswered });
  return problems;
}

function respond({ status, body }: Reply): Response {
  if (body === undefined || status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
