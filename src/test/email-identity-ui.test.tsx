import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { parseMutation } from "@/lib/real.schemas";
import { emptyRealState, workspaceState } from "@/lib/real-store";
import type { WorkspaceData } from "@/lib/real.functions";
import type { Thread } from "@/data/inbox";
import { Composer } from "@/components/estim/composer";
import { ContextPanel } from "@/components/estim/context-panel";
import { EmailIdentityCard } from "@/components/estim/email-identity-card";
import { EstimContext } from "@/components/estim/estim-context";
import { WorkspaceContext } from "@/components/estim/workspace-context";

const UUID1 = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";
const UUID3 = "33333333-3333-4333-8333-333333333333";

describe("email identity mutations and state mapping", () => {
  it("validates approve-email-sender and merge-email-thread mutations strictly", () => {
    expect(
      parseMutation({
        kind: "approve-email-sender",
        id: UUID1,
        name: " Anna ",
        email: "anna@kund.se",
        phone: "0701234567",
        useCustomerId: UUID2,
      }),
    ).toEqual({
      kind: "approve-email-sender",
      id: UUID1,
      name: "Anna",
      email: "anna@kund.se",
      phone: "0701234567",
      useCustomerId: UUID2,
    });
    expect(() => parseMutation({ kind: "approve-email-sender", id: "not-a-uuid" })).toThrow();
    expect(() =>
      parseMutation({ kind: "approve-email-sender", id: UUID1, email: "bad-email" }),
    ).toThrow();
    expect(parseMutation({ kind: "merge-email-thread", sourceId: UUID1, targetId: UUID2 })).toEqual(
      {
        kind: "merge-email-thread",
        sourceId: UUID1,
        targetId: UUID2,
      },
    );
    expect(() =>
      parseMutation({ kind: "merge-email-thread", sourceId: UUID1, targetId: "bad" }),
    ).toThrow();
  });

  it("maps pending_sender and suggested_merge_thread_id from workspace data without affecting normal threads", () => {
    const baseThread = {
      id: UUID1,
      company_id: UUID3,
      customer_id: UUID2,
      job: "Badrum",
      place: null,
      channel: "email",
      status: "svar",
      read: false,
      autopilot: false,
      whatsapp_auto_override: null,
      last_message_at: "2026-11-26T10:00:00Z",
      last_customer_wa_at: null,
      asks: [],
      facts: [],
      why: "",
      created_at: "2026-11-26T10:00:00Z",
      updated_at: "2026-11-26T10:00:00Z",
      pending_sender: { name: "Kalle", email: "kalle@kund.se", phone: "070111", source: "form" },
      suggested_merge_thread_id: UUID3,
    };
    const data = {
      platform: false,
      role: "ägare",
      company: null,
      profile: null,
      threads: [
        baseThread,
        { ...baseThread, id: UUID3, pending_sender: null, suggested_merge_thread_id: null },
      ],
      customers: [
        {
          id: UUID2,
          company_id: UUID3,
          name: "Okänd avsändare",
          email: null,
          phone: null,
          address: null,
          place: null,
          created_at: "2026-11-26T10:00:00Z",
          updated_at: "2026-11-26T10:00:00Z",
        },
      ],
      messages: [],
      quotes: [],
      drafts: [],
      moments: [],
      audit: [],
      channels: [],
    } as unknown as WorkspaceData;

    const mapped = workspaceState(data, emptyRealState());
    expect(mapped.threads[0]!.pendingSender).toEqual({
      name: "Kalle",
      email: "kalle@kund.se",
      phone: "070111",
      source: "form",
    });
    expect(mapped.threads[0]!.suggestedMergeThreadId).toBe(UUID3);
    expect(mapped.threads[1]!.pendingSender).toBeNull();
    expect(mapped.threads[1]!.suggestedMergeThreadId).toBeNull();
  });
});

function renderCard(
  thread: Thread,
  opts: {
    mode?: "real" | "demo";
    threads?: Thread[];
    customers?: { id: string; name: string; email: string | null }[];
    approve?: ReturnType<typeof vi.fn>;
    merge?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const approveEmailSender = opts.approve ?? vi.fn();
  const mergeEmailThread = opts.merge ?? vi.fn();
  const state = { ...emptyRealState(), threads: opts.threads ?? [thread] };
  const fakeStore = {
    subscribe: () => () => {},
    getSnapshot: () => state,
    actions: { approveEmailSender, mergeEmailThread } as never,
  };
  const workspace = {
    mode: opts.mode ?? "real",
    realStore: fakeStore,
    data: { customers: opts.customers ?? [] } as never,
  } as never;
  return {
    approveEmailSender,
    mergeEmailThread,
    ...render(
      <WorkspaceContext.Provider value={workspace}>
        <EstimContext.Provider value={fakeStore as never}>
          <EmailIdentityCard thread={thread} />
        </EstimContext.Provider>
      </WorkspaceContext.Provider>,
    ),
  };
}

const sampleThread = (over: Partial<Thread> = {}): Thread => ({
  id: UUID1,
  customerId: UUID2,
  name: "Okänd avsändare",
  ini: "OA",
  ch: "email",
  chs: ["email"],
  time: "12:00",
  place: "",
  addr: "—",
  phone: "—",
  email: "—",
  job: "Ny förfrågan",
  status: "svar",
  read: true,
  autopilot: false,
  waWin: false,
  msgs: [],
  asks: [],
  facts: [],
  why: "",
  att: [],
  events: [],
  q: null,
  ...over,
});

describe("EmailIdentityCard UI", () => {
  it("renders nothing for ordinary threads or in demo mode", () => {
    const { container } = renderCard(sampleThread());
    expect(container.innerHTML).toBe("");

    const demo = renderCard(
      sampleThread({
        pendingSender: { name: "Kalle", email: "k@x.se", phone: null, source: "form" },
      }),
      { mode: "demo" },
    );
    expect(demo.container.innerHTML).toBe("");
  });

  it("approves edited pending sender and offers matching existing customer", () => {
    const { approveEmailSender } = renderCard(
      sampleThread({
        pendingSender: { name: "Kalle", email: "kalle@kund.se", phone: "070111", source: "form" },
      }),
      { customers: [{ id: UUID3, name: "Kalle Karlsson", email: "kalle@kund.se" }] },
    );

    expect(screen.getByText("Godkänn avsändare (formulärmejl)")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Föreslaget namn"), { target: { value: "Kalle K" } });
    fireEvent.click(screen.getByRole("button", { name: "Godkänn avsändare" }));
    expect(approveEmailSender).toHaveBeenCalledWith(UUID1, {
      name: "Kalle K",
      email: "kalle@kund.se",
      phone: "070111",
    });

    fireEvent.click(screen.getByRole("button", { name: "Koppla till Kalle Karlsson" }));
    expect(approveEmailSender).toHaveBeenCalledWith(UUID1, {
      name: "Kalle K",
      email: "kalle@kund.se",
      phone: "070111",
      useCustomerId: UUID3,
    });
  });

  it("confirms and triggers 1-click thread merge for suggestedMergeThreadId", () => {
    const target = sampleThread({ id: UUID3, job: "Badrumsrenovering" });
    const source = sampleThread({ id: UUID1, suggestedMergeThreadId: UUID3 });
    const { mergeEmailThread } = renderCard(source, { threads: [source, target] });

    fireEvent.click(screen.getByRole("button", { name: "Slå ihop med befintlig tråd" }));
    fireEvent.click(screen.getByRole("button", { name: "Slå ihop" }));
    expect(mergeEmailThread).toHaveBeenCalledWith(UUID1, UUID3);
  });

  it("places EmailIdentityCard at the top of ContextPanel before Uppgifter, Offert and Kund", () => {
    const thread = sampleThread({
      asks: [["Pris på laddbox", 1]],
      facts: [["info", "Villa i Täby"]],
      pendingSender: { name: "Kalle", email: "kalle@kund.se", phone: "070111", source: "form" },
    });
    const state = { ...emptyRealState(), threads: [thread] };
    const fakeStore = {
      subscribe: () => () => {},
      getSnapshot: () => state,
      actions: {
        approveEmailSender: vi.fn(),
        mergeEmailThread: vi.fn(),
        openDrawer: vi.fn(),
      } as never,
    };
    const workspace = {
      mode: "real",
      realStore: fakeStore,
      data: { customers: [], drafts: [] } as never,
    } as never;

    render(
      <WorkspaceContext.Provider value={workspace}>
        <EstimContext.Provider value={fakeStore as never}>
          <ContextPanel thread={thread} />
        </EstimContext.Provider>
      </WorkspaceContext.Provider>,
    );

    const cardHeading = screen.getByText("Godkänn avsändare (formulärmejl)");
    const asksHeading = screen.getByText("Kundens frågor");
    const factsHeading = screen.getByText("Uppgifter");
    const customerHeading = screen.getByText("Kund");

    expect(
      cardHeading.compareDocumentPosition(asksHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      cardHeading.compareDocumentPosition(factsHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      cardHeading.compareDocumentPosition(customerHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("disables email sending in Composer while pendingSender awaits approval and re-enables once approved", () => {
    if (typeof globalThis.ResizeObserver === "undefined") {
      globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
    }

    const baseDraft = {
      text: "Hej, här kommer svar.",
      ch: "email" as const,
      v: "std" as const,
      att: [],
      review: true,
      edited: true,
      busy: false,
      warn: ["Formulärmejl: kontrollera och godkänn avsändarens uppgifter innan du svarar."],
    };

    const pendingThread = sampleThread({
      pendingSender: { name: "Kalle", email: "kalle@kund.se", phone: null, source: "form" },
    });
    const pendingState = {
      ...emptyRealState(),
      threads: [pendingThread],
      drafts: { [pendingThread.id]: baseDraft },
    };
    const pendingStore = {
      subscribe: () => () => {},
      getSnapshot: () => pendingState,
      actions: {
        send: vi.fn(),
        editDraft: vi.fn(),
        setDraft: vi.fn(),
        setCh: vi.fn(),
        addAtt: vi.fn(),
        delAtt: vi.fn(),
        openDrawer: vi.fn(),
      } as never,
    };
    const workspace = {
      mode: "real",
      realStore: pendingStore,
      data: { customers: [], drafts: [] } as never,
    } as never;

    const { rerender } = render(
      <WorkspaceContext.Provider value={workspace}>
        <EstimContext.Provider value={pendingStore as never}>
          <Composer thread={pendingThread} />
        </EstimContext.Provider>
      </WorkspaceContext.Provider>,
    );

    const sendBtn = screen.getByRole("button", { name: "Godkänn och skicka" }) as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
    expect(screen.getByText("Godkänn avsändaren till höger innan du skickar.")).toBeTruthy();

    const approvedThread = sampleThread({
      email: "kalle@kund.se",
      pendingSender: null,
    });
    const approvedState = {
      ...emptyRealState(),
      threads: [approvedThread],
      drafts: { [approvedThread.id]: baseDraft },
    };
    const approvedStore = {
      ...pendingStore,
      getSnapshot: () => approvedState,
    };

    rerender(
      <WorkspaceContext.Provider
        value={{ ...(workspace as object), realStore: approvedStore } as never}
      >
        <EstimContext.Provider value={approvedStore as never}>
          <Composer thread={approvedThread} />
        </EstimContext.Provider>
      </WorkspaceContext.Provider>,
    );

    expect(
      (screen.getByRole("button", { name: "Godkänn och skicka" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.queryByText("Godkänn avsändaren till höger innan du skickar.")).toBeNull();
  });
});
