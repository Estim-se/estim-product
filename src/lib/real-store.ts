import { initial, type EstimState, type Draft, type DesktopPath } from "./estim-store";
import type { WorkspaceData } from "./real.functions";
import type { RealMutation } from "./real.schemas";
import type { PendingSender, Thread } from "@/data/inbox";
import type { Quote } from "./quote";
import { auditTimeline } from "./real-presentation";
import { waWindowOpen } from "./channel-rules";
import { whatsappAutoReply } from "./whatsapp-auto";
import { toAttachmentItems } from "./mail-attachments";

// AI steps are injected so the store stays testable without network access.
export interface RealAi {
  interpret(id: string): Promise<unknown>;
  write(id: string, v: Draft["v"], ch: "email" | "sms" | "wa"): Promise<unknown>;
}

const TIME_FMT = new Intl.DateTimeFormat("sv-SE", { hour: "2-digit", minute: "2-digit" });
const time = (value: string) => TIME_FMT.format(new Date(value));
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const rows = (value: unknown): string[][] =>
  Array.isArray(value) ? value.filter(Array.isArray).map((row) => row.map(String)) : [];
const asks = (value: unknown): (string | number)[][] =>
  Array.isArray(value)
    ? value.filter(Array.isArray).map((row) => [String(row[0] ?? ""), row[1] ? 1 : 0])
    : [];
export function emptyRealState(): EstimState {
  const s = initial();
  return {
    ...s,
    threads: [],
    drafts: {},
    sel: "",
    stats: { ai: 0, sek: 0 },
    settings: [true, true, false, true, true, true, true],
  };
}
const USER_MESSAGES = new Set([
  "Vänta tills AI:n är klar.",
  "Jobbet kunde inte markeras som vunnet.",
  "Jobbet kunde inte återställas.",
  "Meddelandet kunde inte flyttas.",
  "Kunderna kunde inte slås ihop.",
  "Välj två olika kunder.",
  "Avsändaren är redan godkänd.",
  "Avsändaren kunde inte godkännas.",
  "Välj två olika trådar.",
  "Tråden har en offert eller ett samtal och kan inte slås ihop.",
  "Trådarna kunde inte slås ihop.",
]);

function parsePendingSender(raw: unknown): PendingSender | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const source = o["source"] === "unverified" || o["source"] === "no_reply" ? o["source"] : "form";
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return { name: str(o["name"]), email: str(o["email"]), phone: str(o["phone"]), source };
}

export function workspaceState(data: WorkspaceData, previous: EstimState): EstimState {
  const drafts: Record<string, Draft> = {};
  for (const d of data.drafts) {
    const warn = strings(d.warnings);
    drafts[d.thread_id] = {
      text: d.text,
      v: d.variant === "kort" || d.variant === "formell" ? d.variant : "std",
      ch: d.channel,
      att: strings(d.attachments),
      edited: d.edited,
      warn,
      review: d.needs_review && warn.length > 0,
    };
  }

  // Pre-index all related collections in O(N) maps so hydration scales linearly instead of O(T*M + T*A).
  const customersById = new Map(data.customers.map((c) => [c.id, c]));
  const quoteByThread = new Map<string, WorkspaceData["quotes"][number]>();
  for (const q of data.quotes) {
    if (!quoteByThread.has(q.thread_id)) quoteByThread.set(q.thread_id, q);
  }
  const deliveriesByMsg = new Map<string, { id: string; name: string }[]>();
  for (const d of data.documentDeliveries ?? []) {
    if (!d.message_id) continue;
    let list = deliveriesByMsg.get(d.message_id);
    if (!list) {
      list = [];
      deliveriesByMsg.set(d.message_id, list);
    }
    list.push({ id: d.id, name: d.name });
  }
  const outgoingByThread = new Map<string, WorkspaceData["messages"][number]>();
  const visibleMsgsByThread = new Map<string, WorkspaceData["messages"][number][]>();
  let aiCount = 0;
  for (const m of data.messages) {
    if (m.from === "ai") aiCount++;
    if (m.from === "vv" || m.from === "ai") outgoingByThread.set(m.thread_id, m);
    if (m.delivery_status === "sent" || deliveriesByMsg.has(m.id)) {
      let list = visibleMsgsByThread.get(m.thread_id);
      if (!list) {
        list = [];
        visibleMsgsByThread.set(m.thread_id, list);
      }
      list.push(m);
    }
  }
  const auditByThread = new Map<string, WorkspaceData["audit"][number][]>();
  for (const a of data.audit) {
    const after = a.after;
    if (after && typeof after === "object" && !Array.isArray(after)) {
      const tid = (after as Record<string, unknown>)["thread_id"];
      if (typeof tid === "string") {
        let list = auditByThread.get(tid);
        if (!list) {
          list = [];
          auditByThread.set(tid, list);
        }
        list.push(a);
      }
    }
  }

  const now = Date.now();
  const threads: Thread[] = data.threads.map((t) => {
    const c = customersById.get(t.customer_id);
    const q = quoteByThread.get(t.id);
    const outgoing = outgoingByThread.get(t.id);
    const msgs = (visibleMsgsByThread.get(t.id) ?? []).map((m) => {
      const att = strings(m.attachments);
      return {
        id: m.id,
        from: m.from,
        auto: m.from === "ai",
        ch: m.channel ?? t.channel,
        time: time(m.sent_at),
        text: m.delivery_status === "sent" ? m.text : "Dokument skickat",
        att,
        attachmentFiles: toAttachmentItems(m.attachment_files),
        documents: deliveriesByMsg.get(m.id) ?? [],
        quote: att.some((a) => a.startsWith("Offert")),
      };
    });
    const threadAudit = auditByThread.get(t.id);
    const events: [string, string][] = [];
    if (threadAudit) {
      for (let i = threadAudit.length - 1; i >= 0; i--) {
        const a = threadAudit[i]!;
        events.push([time(a.created_at), auditTimeline(a)]);
      }
    }
    return {
      deliveryError:
        outgoing?.channel === "wa" && outgoing.delivery_status === "not_sent"
          ? (outgoing.delivery_error ?? "WhatsApp-svaret kunde inte skickas. Försök igen.")
          : undefined,
      waSent:
        outgoing?.channel === "wa" &&
        outgoing.delivery_status === "sent" &&
        Boolean(outgoing.provider_message_id),
      id: t.id,
      customerId: t.customer_id,
      name: c?.name ?? "",
      ini: (c?.name ?? "")
        .split(" ")
        .map((n) => n[0])
        .slice(0, 2)
        .join(""),
      ch: t.channel,
      chs: [...new Set([t.channel, ...msgs.map((m) => m.ch)])],
      time: time(t.last_message_at),
      place: c?.place ?? t.place ?? "",
      addr: c?.address ?? "—",
      phone: c?.phone || "—",
      email: c?.email || "—",
      job: t.job,
      status:
        t.status === "analys" && now - new Date(t.updated_at).getTime() > 90000
          ? "svar"
          : t.status,
      read: t.read,
      autopilot:
        t.channel === "wa"
          ? whatsappAutoReply(data.company?.whatsapp_auto_reply ?? false, t.whatsapp_auto_override)
          : t.autopilot,
      waWin: waWindowOpen(t.last_customer_wa_at),
      msgs,
      asks: asks(t.asks),
      facts: rows(t.facts),
      why: t.why,
      att: [],
      events,
      q: q
        ? {
            nr: q.nr,
            owners: q.owners,
            addOn: q.add_on,
            prisform: q.prisform,
            lines: Array.isArray(q.lines) ? (q.lines as unknown as Quote["lines"]) : [],
          }
        : null,
      pendingSender: parsePendingSender(t.pending_sender),
      suggestedMergeThreadId: t.suggested_merge_thread_id ?? null,
    };
  });
  return {
    ...previous,
    threads,
    drafts,
    settings: Array.isArray(data.company?.settings)
      ? data.company.settings.map(Boolean)
      : previous.settings,
    sel: threads.some((t) => t.id === previous.sel) ? previous.sel : (threads[0]?.id ?? ""),
    stats: { ai: aiCount, sek: 0 },
  };
}

// Real actions never invoke the demo store: no scripts, fake replies, or simulated approvals.
export function createRealStore() {
  let state = emptyRealState();
  const listeners = new Set<() => void>();
  let data: WorkspaceData | null = null;
  let mutate: ((input: RealMutation) => Promise<unknown>) | undefined;
  let reload: (() => Promise<void>) | undefined;
  let queue = Promise.resolve();
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let writeError = false;
  let ai: RealAi | undefined;
  let delivery: ((id: string) => Promise<{ sent: boolean; error: string | null }>) | undefined;
  const AI_TIMEOUT_MS = 60000;
  const withTimeout = <T>(p: Promise<T>) =>
    new Promise<T>((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout")), AI_TIMEOUT_MS);
      p.then(
        (v) => {
          clearTimeout(t);
          res(v);
        },
        (e) => {
          clearTimeout(t);
          rej(e);
        },
      );
    });
  // Any AI failure or timeout returns the thread to "svar" so the user can write by hand.
  const aiFailed = async (id: string) => {
    update((s) => {
      const t = s.threads.find((t) => t.id === id);
      if (t && t.status === "analys") t.status = "svar";
    });
    toast("AI kunde inte svara just nu");
    try {
      await persist({ kind: "thread", id, status: "svar" });
    } catch {
      /* persist has already shown its own error toast */
    }
    try {
      await reload?.();
    } catch {
      /* a failed refresh keeps the local state; the next reload catches up */
    }
  };
  // Runs one AI reply for a thread; failures keep the thread usable for manual writing.
  const aiReply = async (id: string, v: Draft["v"]) => {
    const d = state.drafts[id];
    if (!ai || !d) return;
    const ch = d.ch === "sms" || d.ch === "wa" ? d.ch : "email";
    patchDraft(id, (x) => ({ ...x, busy: true }));
    try {
      // Saves pending text edits under the current variant; the new variant is shown once its reply exists.
      flushDraft(id);
      await queue;
      const res = (await withTimeout(ai.write(id, v, ch))) as {
        text?: unknown;
        why?: unknown;
        warnings?: unknown;
        needs_review?: unknown;
      } | null;
      // Apply the generated reply immediately so the user sees it without waiting for a full reload.
      if (res && typeof res.text === "string") {
        const warn = strings(res.warnings);
        patchDraft(id, (x) => ({
          ...x,
          text: res.text as string,
          v,
          edited: false,
          warn,
          review: Boolean(res.needs_review) && warn.length > 0,
          busy: false,
        }));
        if (typeof res.why === "string") {
          const nextWhy = res.why;
          update((s) => {
            const t = s.threads.find((th) => th.id === id);
            if (t) t.why = nextWhy;
          });
        }
        // Refresh full workspace quietly in the background without blocking the UI.
        void reload?.().catch(() => {});
      } else {
        await reload?.();
      }
    } catch {
      await aiFailed(id);
    } finally {
      patchDraft(id, (x) => (x.busy ? { ...x, busy: false } : x));
    }
  };
  let epoch = 0;
  const dirtyQuotes = new Set<string>();
  const draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const draftRevisions = new Map<string, number>();
  const dirtyDrafts = new Set<string>();
  const DRAFT_DEBOUNCE_MS = 450;
  // Optimistic thread fields (read, autopilot) are reapplied over polls that were read before the write landed.
  const OPTIMISTIC_HOLD_MS = 30_000;
  type ThreadPatch = { read?: boolean; autopilot?: boolean; until?: number };
  const optimistic = new Map<string, ThreadPatch>();
  const holdThread = (id: string, patch: Omit<ThreadPatch, "until">) => {
    const { until: _settled, ...held } = optimistic.get(id) ?? {};
    optimistic.set(id, { ...held, ...patch });
  };
  const settleThread = (id: string, failed: boolean, field: "read" | "autopilot") => {
    const held = optimistic.get(id);
    if (!held) return;
    if (failed) {
      delete held[field];
      if (held.read === undefined && held.autopilot === undefined) optimistic.delete(id);
    } else held.until = Date.now() + OPTIMISTIC_HOLD_MS;
  };
  // Only known user-facing server messages are shown; anything else gets the generic text.
  const serverMessage = (error: unknown) =>
    error instanceof Error && USER_MESSAGES.has(error.message)
      ? error.message
      : "Ändringen kunde inte sparas. Försök igen.";
  const notify = () => listeners.forEach((l) => l());
  const update = (fn: (s: EstimState) => void) => {
    state = structuredClone(state);
    fn(state);
    notify();
  };
  // Shallow structural-sharing draft update: keeps state.threads reference-identical on every keystroke.
  const patchDraft = (id: string, fn: (d: Draft) => Draft) => {
    const cur = state.drafts[id];
    if (!cur) return;
    const next = fn(cur);
    if (next === cur) return;
    state = { ...state, drafts: { ...state.drafts, [id]: next } };
    notify();
  };
  const toast = (text: string) => {
    clearTimeout(toastTimer);
    state = { ...state, toast: text };
    notify();
    toastTimer = setTimeout(() => {
      state = { ...state, toast: "" };
      notify();
    }, 3200);
  };
  // ownErrorToast: the caller shows its own (more specific) failure message.
  const persist = (input: RealMutation, refresh = false, ownErrorToast = false) => {
    const write = mutate,
      read = reload;
    const own = epoch;
    const task = queue.then(async (): Promise<unknown> => {
      if (own !== epoch) return undefined;
      if (!write) throw new Error("Ingen anslutning.");
      const out = await write(input);
      if (own === epoch && refresh && read) await read();
      return out;
    });
    queue = task
      .then(() => {
        writeError = false;
      })
      .catch(() => {
        writeError = true;
        if (!ownErrorToast) toast("Ändringen kunde inte sparas. Försök igen.");
      });
    return task;
  };
  const flushDraft = (id: string, onFailure?: () => void) => {
    const pending = draftTimers.get(id);
    if (pending) {
      clearTimeout(pending);
      draftTimers.delete(id);
    }
    const draft = state.drafts[id];
    if (!draft) {
      dirtyDrafts.delete(id);
      return;
    }
    const rev = (draftRevisions.get(id) ?? 0) + 1;
    draftRevisions.set(id, rev);
    dirtyDrafts.add(id);
    const snapshot = {
      ...draft,
      ch: draft.ch === "sms" ? ("sms" as const) : draft.ch === "wa" ? ("wa" as const) : ("email" as const),
    };
    void persist({ kind: "draft", id, draft: snapshot })
      .then(() => {
        if (draftRevisions.get(id) === rev) dirtyDrafts.delete(id);
      })
      .catch(() => {
        if (draftRevisions.get(id) === rev) {
          dirtyDrafts.delete(id);
          onFailure?.();
        }
      });
  };
  const scheduleDraftSave = (id: string) => {
    const prev = draftTimers.get(id);
    if (prev) clearTimeout(prev);
    const rev = (draftRevisions.get(id) ?? 0) + 1;
    draftRevisions.set(id, rev);
    dirtyDrafts.add(id);
    draftTimers.set(
      id,
      setTimeout(() => {
        draftTimers.delete(id);
        flushDraft(id);
      }, DRAFT_DEBOUNCE_MS),
    );
  };
  const flushAllDrafts = () => {
    for (const id of Array.from(draftTimers.keys())) flushDraft(id);
  };
  // Quote fields are visit-local until the explicit drawer save succeeds.
  const changeQuote = (fn: (q: Quote) => void) => {
    const id = state.drawer;
    if (!id) return;
    dirtyQuotes.add(id);
    update((s) => {
      const q = s.threads.find((t) => t.id === id)?.q;
      if (q) fn(q);
    });
  };
  // New request flow: analys -> interpret -> code-built quote -> reply draft -> svar. Never sends.
  async function actions_runRequest(id: string) {
    if (!ai) return;
    update((s) => {
      const t = s.threads.find((t) => t.id === id);
      if (t) t.status = "analys";
    });
    try {
      await withTimeout(ai.interpret(id));
      const channel = state.drafts[id]?.ch;
      await withTimeout(
        ai.write(id, "std", channel === "sms" || channel === "wa" ? channel : "email"),
      );
    } catch {
      await aiFailed(id);
      return;
    }
    try {
      await reload?.();
    } catch {
      /* a failed refresh keeps the local state; the next reload catches up */
    }
  }
  const actions = {
    update,
    toast,
    reset() {
      toast("Återställning finns bara i demoläge.");
    },
    select(id: string) {
      const target = state.threads.find((t) => t.id === id);
      const wasUnread = Boolean(target && !target.read);
      if (wasUnread) {
        update((s) => {
          s.sel = id;
          s.view = "desk";
          s.page = "inkorg";
          const t = s.threads.find((th) => th.id === id);
          if (t) t.read = true;
        });
        holdThread(id, { read: true });
        void persist({ kind: "thread", id, read: true }).then(() => settleThread(id, false, "read")).catch(() => {
          settleThread(id, true, "read");
          update((s) => {
            const t = s.threads.find((th) => th.id === id);
            if (t) t.read = false;
          });
        });
      } else {
        state = { ...state, sel: id, view: "desk", page: "inkorg" };
        notify();
      }
    },
    toggleSetting(index: number) {
      update((s) => {
        s.settings[index] = !s.settings[index];
      });
      const c = data?.company;
      if (c)
        void persist(
          {
            kind: "company",
            company: {
              name: c.name,
              signature: c.signature,
              hourly_rate_ex_vat: c.hourly_rate_ex_vat,
              travel_fee: c.travel_fee,
              settings: state.settings,
              reply_to_email: c.reply_to_email ?? "",
            },
          },
          true,
        ).catch(() => {});
    },
    toggleAuto(id: string) {
      const t = state.threads.find((t) => t.id === id);
      if (!t || t.ch !== "wa") return;
      const previous = t.autopilot;
      const autopilot = !previous;
      // Optimistic flip (0 ms) with rollback if the server write fails.
      update((s) => {
        const thread = s.threads.find((th) => th.id === id);
        if (thread) thread.autopilot = autopilot;
      });
      holdThread(id, { autopilot });
      void persist({ kind: "thread", id, autopilot })
        .then(() => {
          settleThread(id, false, "autopilot");
          toast(
            autopilot
              ? "AI skickar svar automatiskt i den här WhatsApp-tråden."
              : "AI skriver utkast, du skickar",
          );
        })
        .catch(() => {
          if (optimistic.get(id)?.autopilot === autopilot) settleThread(id, true, "autopilot");
          update((s) => {
            const thread = s.threads.find((th) => th.id === id);
            if (thread && thread.autopilot === autopilot) thread.autopilot = previous;
          });
        });
    },
    setDraft(id: string, variant: Draft["v"]) {
      if (state.drafts[id]?.busy) return;
      void aiReply(id, variant);
    },
    regen(id: string) {
      const d = state.drafts[id];
      if (d && !d.busy) void aiReply(id, d.v);
    },
    editDraft(id: string, text: string) {
      patchDraft(id, (d) => ({ ...d, text, edited: true }));
      scheduleDraftSave(id);
    },
    addAtt(id: string, value: string) {
      if (!value) return;
      const before = state.drafts[id]?.att.slice();
      patchDraft(id, (d) => (d.att.includes(value) ? d : { ...d, att: [...d.att, value] }));
      flushDraft(id, () => {
        if (before) patchDraft(id, (d) => ({ ...d, att: before }));
      });
    },
    delAtt(id: string, index: number) {
      const before = state.drafts[id]?.att.slice();
      patchDraft(id, (d) => ({ ...d, att: d.att.filter((_, i) => i !== index) }));
      flushDraft(id, () => {
        if (before) patchDraft(id, (d) => ({ ...d, att: before }));
      });
    },
    setCh(id: string, ch: string) {
      if (ch !== "email" && ch !== "sms" && ch !== "wa") return;
      const before = state.drafts[id]?.ch;
      patchDraft(id, (d) => ({ ...d, ch }));
      flushDraft(id, () => {
        if (before) patchDraft(id, (d) => ({ ...d, ch: before }));
      });
    },
    openDrawer(id: string) {
      state = { ...state, drawer: id };
      notify();
    },
    closeDrawer() {
      const id = state.drawer;
      const wasDirty = Boolean(id && dirtyQuotes.has(id));
      if (id) dirtyQuotes.delete(id);
      if (wasDirty && id && data) {
        const persistedQuote = data.quotes.find((q) => q.thread_id === id);
        const restored: Quote | null = persistedQuote
          ? {
              nr: persistedQuote.nr,
              owners: persistedQuote.owners,
              addOn: persistedQuote.add_on,
              prisform: persistedQuote.prisform,
              lines: Array.isArray(persistedQuote.lines)
                ? (persistedQuote.lines as unknown as Quote["lines"])
                : [],
            }
          : null;
        update((s) => {
          s.drawer = null;
          const t = s.threads.find((th) => th.id === id);
          if (t) t.q = restored;
        });
      } else {
        state = { ...state, drawer: null };
        notify();
      }
    },
    upd(index: number, key: "t" | "q" | "p", value: string) {
      changeQuote((q) => {
        const l = q.lines[index];
        if (!l) return;
        if (key === "t") l.t = value;
        else l[key] = Math.max(0, parseFloat(value.replace(/\s/g, "").replace(",", ".")) || 0);
      });
    },
    togRot(index: number) {
      changeQuote((q) => {
        const l = q.lines[index];
        if (l) l.rot = !l.rot;
      });
    },
    delL(index: number) {
      changeQuote((q) => {
        q.lines.splice(index, 1);
      });
    },
    addL(opt = false) {
      changeQuote((q) => {
        q.lines.push({
          t: opt ? "Nytt tillval" : "Ny rad",
          typ: "arbete",
          q: 1,
          u: "h",
          p: data?.company?.hourly_rate_ex_vat ?? 0,
          rot: true,
          ...(opt ? { opt: true } : {}),
        });
      });
    },
    setOwners(owners: number) {
      changeQuote((q) => {
        q.owners = owners;
      });
    },
    setPriceForm(prisform: string) {
      changeQuote((q) => {
        q.prisform = prisform;
      });
    },
    openCustomer(_id: string, _preview?: boolean) {
      toast("Kundens godkännande ansluts i ett senare steg.");
    },
    closeCustomer() {},
    markWon(id: string) {
      const t = state.threads.find((t) => t.id === id);
      if (!t) return;
      const won = t.status !== "vunnen";
      if (won && t.status === "analys") {
        toast("Vänta tills AI:n är klar.");
        return;
      }
      // The server decides the resulting status; the reload shows it only after a confirmed write.
      void persist({ kind: "won", id, won }, true, true)
        .then(() => {
          toast(won ? "Jobbet markerat som vunnet." : "Jobbet är återställt.");
        })
        .catch((error) => {
          toast(serverMessage(error));
        });
    },
    // Moves a customer message and everything after it to a new case for the same customer.
    splitThread(id: string, messageId: string) {
      const t = state.threads.find((t) => t.id === id);
      if (!t) return;
      if (t.status === "analys") {
        toast("Vänta tills AI:n är klar.");
        return;
      }
      void persist({ kind: "split", id, message: messageId }, true, true)
        .then((result) => {
          const next =
            result && typeof result === "object" && "id" in result && typeof result.id === "string"
              ? result.id
              : "";
          if (next) actions.select(next);
          toast("Meddelandet är flyttat till ett nytt ärende.");
        })
        .catch((error) => {
          toast(serverMessage(error));
        });
    },
    // Joins two customer records; each conversation keeps its own channel.
    mergeCustomers(keep: string, drop: string) {
      void persist({ kind: "merge", keep, drop }, true, true)
        .then(() => {
          toast("Kunderna är sammanslagna.");
        })
        .catch((error) => {
          toast(serverMessage(error));
        });
    },
    // Approves a quarantined email sender suggestion (form mail / unverified).
    approveEmailSender(
      id: string,
      input: { name?: string; email?: string; phone?: string; useCustomerId?: string },
    ) {
      return persist({ kind: "approve-email-sender", id, ...input }, true, true)
        .then(() => {
          toast("Avsändaren är godkänd.");
        })
        .catch((error) => {
          toast(serverMessage(error));
        });
    },
    // Merges a new email thread into the suggested existing open thread.
    mergeEmailThread(sourceId: string, targetId: string) {
      return persist({ kind: "merge-email-thread", sourceId, targetId }, true, true)
        .then(() => {
          actions.select(targetId);
          toast("Trådarna är sammanslagna.");
        })
        .catch((error) => {
          toast(serverMessage(error));
        });
    },
    toggleAddOn(id: string) {
      dirtyQuotes.add(id);
      update((s) => {
        const q = s.threads.find((t) => t.id === id)?.q;
        if (q) q.addOn = !q.addOn;
      });
    },
    approveCustomer() {},
    submitCustomer() {},
    sendBrief(_id: string) {
      toast("Överlämning är inte ansluten ännu.");
    },
    send(id: string, _options?: { silent?: boolean }) {
      const d = state.drafts[id];
      if (!d?.text.trim()) {
        toast("Skriv ett svar först.");
        return;
      }
      if (d.busy) return;
      patchDraft(id, (draft) => ({ ...draft, busy: true, sending: true }));
      void (async () => {
        try {
          flushDraft(id);
          await queue;
          if (!delivery) throw new Error("Ingen anslutning.");
          const result = await delivery(id);
          await reload?.();
          if (result.sent) {
            toast(d.ch === "wa" ? "Svar skickat via WhatsApp." : "Svaret är sparat som skickat.");
            if (state.m.scr === "thread" && state.m.id === id) actions.mobileGo("done", id);
          } else {
            const error = result.error ?? "WhatsApp-svaret kunde inte skickas. Försök igen.";
            update((s) => {
              const t = s.threads.find((t) => t.id === id);
              if (t) t.deliveryError = error;
            });
            toast(error);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Svaret kunde inte skickas.";
          if (d.ch === "wa")
            update((s) => {
              const t = s.threads.find((t) => t.id === id);
              if (t) t.deliveryError = message;
            });
          toast(message);
        } finally {
          patchDraft(id, (draft) => ({ ...draft, busy: false, sending: false }));
        }
      })();
    },
    simNew() {
      toast("Använd Ny förfrågan.");
    },
    openMobile(path?: string) {
      update((s) => {
        if (
          path === "/" ||
          path === "/offerter" ||
          path === "/kanaler" ||
          path === "/installningar"
        )
          s.desktopPath = path as DesktopPath;
        s.view = "mob";
        s.m = { scr: "lock", id: null, editing: false };
      });
    },
    mobileGo(scr: EstimState["m"]["scr"], id?: string) {
      update((s) => {
        s.m = { scr, id: id || s.m.id, editing: false };
      });
    },
    mobileEdit() {
      update((s) => {
        s.m.editing = !s.m.editing;
      });
    },
    mobileApprove(id: string) {
      actions.send(id);
    },
    mobilePrice(id: string) {
      actions.select(id);
      actions.openDrawer(id);
    },
  };
  return {
    getSnapshot: () => state,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    actions,
    connectAi(next: RealAi) {
      ai = next;
    },
    connectDelivery(next: (id: string) => Promise<{ sent: boolean; error: string | null }>) {
      delivery = next;
    },
    // "Försök igen": rerun only the missing steps (a saved quote means interpretation already ran).
    retryAi(id: string) {
      const t = state.threads.find((t) => t.id === id);
      if (!t) return;
      if (t.q) {
        const d = state.drafts[id];
        if (d && !d.busy) void aiReply(id, d.v);
      } else void actions_runRequest(id);
    },
    // New request flow: analys -> interpret -> code-built quote -> reply draft -> svar. Never sends.
    runRequest: actions_runRequest,
    connect(write: (input: RealMutation) => Promise<unknown>, read: () => Promise<void>) {
      mutate = write;
      reload = read;
    },
    hydrate(next: WorkspaceData) {
      data = next;
      const previous = state;
      const prevById = new Map(previous.threads.map((p) => [p.id, p]));
      state = workspaceState(next, state);
      // Preserve in-progress local draft edits and busy/sending flags while polling runs.
      for (const id of dirtyDrafts) {
        if (previous.drafts[id]) state.drafts[id] = previous.drafts[id]!;
      }
      for (const [id, prevDraft] of Object.entries(previous.drafts)) {
        if ((prevDraft.busy || prevDraft.sending) && state.drafts[id]) {
          state.drafts[id] = {
            ...state.drafts[id]!,
            ...(prevDraft.busy ? { busy: true } : {}),
            ...(prevDraft.sending ? { sending: true } : {}),
          };
        }
      }
      let failed = false;
      const now = Date.now();
      for (const t of state.threads) {
        const held = optimistic.get(t.id);
        if (held) {
          const agrees =
            (held.read === undefined || held.read === t.read) &&
            (held.autopilot === undefined || held.autopilot === t.autopilot);
          if ((agrees && held.until !== undefined) || (held.until !== undefined && now > held.until))
            optimistic.delete(t.id);
          else {
            if (held.read !== undefined) t.read = held.read;
            if (held.autopilot !== undefined) t.autopilot = held.autopilot;
          }
        }
        const prev = prevById.get(t.id);
        if (dirtyQuotes.has(t.id)) t.q = prev?.q ?? t.q;
        if (
          prev?.status === "analys" &&
          t.status === "svar" &&
          !state.drafts[t.id]?.text &&
          state.drafts[t.id]?.warn?.includes("AI kunde inte svara just nu")
        )
          failed = true;
      }
      notify();
      if (failed) toast("AI kunde inte svara just nu");
    },
    clear() {
      epoch++;
      clearTimeout(toastTimer);
      for (const timer of draftTimers.values()) clearTimeout(timer);
      draftTimers.clear();
      draftRevisions.clear();
      dirtyDrafts.clear();
      dirtyQuotes.clear();
      optimistic.clear();
      data = null;
      mutate = undefined;
      reload = undefined;
      queue = Promise.resolve();
      writeError = false;
      state = emptyRealState();
      notify();
    },
    async flush() {
      flushAllDrafts();
      await queue;
      if (writeError) throw new Error("Kunde inte spara.");
    },
    async saveQuote() {
      const id = state.drawer;
      if (!id || !dirtyQuotes.has(id)) return;
      const q = state.threads.find((t) => t.id === id)?.q;
      if (!q) return;
      const quote = {
        ...q,
        owners: q.owners === 2 ? (2 as const) : (1 as const),
        prisform: q.prisform === "fast" ? ("fast" as const) : ("ungefar" as const),
        lines: q.lines.map((l) => ({
          ...l,
          typ:
            l.typ === "arbete"
              ? ("arbete" as const)
              : l.typ === "material"
                ? ("material" as const)
                : ("resa" as const),
        })),
      };
      await persist({ kind: "quote", id, quote });
      dirtyQuotes.delete(id);
      try {
        await reload?.();
      } catch (error) {
        dirtyQuotes.add(id);
        throw error;
      }
      // Regenerate the reply with the saved numbers unless the user edited the text by hand.
      const d = state.drafts[id];
      if (ai && d && !d.edited) void aiReply(id, d.v);
    },
    async createQuote(id: string) {
      await queue;
      dirtyQuotes.add(id);
      const nr = String(Math.max(1000, ...(data?.quotes.map((q) => Number(q.nr)) ?? [])) + 1);
      update((s) => {
        const t = s.threads.find((t) => t.id === id);
        if (t) t.q = { nr, owners: 1, addOn: false, prisform: "ungefar", lines: [] };
      });
      actions.openDrawer(id);
    },
    addMoment(id: string) {
      const moment = data?.moments.find((m) => m.id === id);
      if (!moment) return;
      changeQuote((q) => {
        q.lines.push({
          t: moment.name,
          typ: "arbete",
          q: moment.hours_per_unit,
          u: "h",
          p: data?.company?.hourly_rate_ex_vat ?? 0,
          rot: moment.rot_eligible,
        });
        if (moment.material_per_unit_ex_vat)
          q.lines.push({
            t: moment.name + " · material",
            typ: "material",
            q: 1,
            u: moment.unit,
            p: moment.material_per_unit_ex_vat,
            rot: false,
          });
      });
    },
  };
}
