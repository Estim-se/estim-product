import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  formatAttachmentSize,
  isImageAttachment,
  isInlineSafeType,
  isSafeAttachmentPath,
  parseAttachmentFiles,
  remainingPlainAttachments,
  toAttachmentItems,
} from "@/lib/mail-attachments";
import { emptyRealState, workspaceState } from "@/lib/real-store";
import type { WorkspaceData } from "@/lib/real.functions";
import type { Message as InboxMessage, Thread } from "@/data/inbox";
import { Message } from "@/components/estim/message";
import { WorkspaceContext } from "@/components/estim/workspace-context";

const openMock = vi.fn();
vi.mock("@tanstack/react-start", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-start")>("@tanstack/react-start");
  return {
    ...actual,
    useServerFn: () => openMock,
  };
});

const CID = "11111111-1111-4111-8111-111111111111";
const OTHER_CID = "22222222-2222-4222-8222-222222222222";
const TID = "33333333-3333-4333-8333-333333333333";
const MID = "44444444-4444-4444-8444-444444444444";

describe("mail attachment helpers", () => {
  it("validates storage paths strictly against company prefix and traversal", () => {
    expect(isSafeAttachmentPath(`${CID}/inbox/abc123/1-ritning.pdf`, CID)).toBe(true);
    expect(isSafeAttachmentPath(`${OTHER_CID}/inbox/abc123/1-ritning.pdf`, CID)).toBe(false);
    expect(isSafeAttachmentPath(`${CID}/inbox/../other/1-ritning.pdf`, CID)).toBe(false);
    expect(isSafeAttachmentPath(`${CID}/other/1-ritning.pdf`, CID)).toBe(false);
    expect(isSafeAttachmentPath(`${CID}/inbox/\\evil.pdf`, CID)).toBe(false);
    expect(isSafeAttachmentPath("", CID)).toBe(false);
  });

  it("parses attachment_files safely and strips storage paths for UI items", () => {
    const raw = [
      {
        name: "ritning.pdf",
        type: "application/pdf",
        size: 245760,
        path: `${CID}/inbox/h/1-ritning.pdf`,
      },
      { name: "", path: `${CID}/inbox/h/empty.pdf` },
      "invalid",
    ];
    expect(parseAttachmentFiles(raw)).toHaveLength(1);
    const items = toAttachmentItems(raw);
    expect(items).toEqual([
      { index: 0, name: "ritning.pdf", type: "application/pdf", size: 245760 },
    ]);
    expect("path" in items[0]!).toBe(false);
  });

  it("classifies inline-safe types, image icons, sizes, and deduplicates plain labels", () => {
    expect(isInlineSafeType("application/pdf")).toBe(true);
    expect(isInlineSafeType("image/jpeg")).toBe(true);
    expect(isInlineSafeType("text/html")).toBe(false);
    expect(isInlineSafeType("image/svg+xml")).toBe(false);
    expect(isImageAttachment("foto.jpg")).toBe(true);
    expect(isImageAttachment("ritning.pdf", "application/pdf")).toBe(false);
    expect(formatAttachmentSize(245760)).toBe("240 kB");
    expect(formatAttachmentSize(1_572_864)).toBe("1,5 MB");
    expect(
      remainingPlainAttachments(
        ["ritning.pdf", "extra.txt"],
        [{ index: 0, name: "ritning.pdf", type: "application/pdf", size: 100 }],
        false,
      ),
    ).toEqual(["extra.txt"]);
  });

  it("maps attachment_files in workspaceState without exposing storage paths", () => {
    const data = {
      platform: false,
      role: "ägare",
      company: { id: CID, name: "Firma AB", settings: [] },
      profile: null,
      threads: [
        {
          id: TID,
          company_id: CID,
          customer_id: OTHER_CID,
          job: "Badrum",
          place: null,
          channel: "email",
          status: "svar",
          read: true,
          autopilot: false,
          whatsapp_auto_override: null,
          last_message_at: "2026-11-26T10:00:00Z",
          last_customer_wa_at: null,
          asks: [],
          facts: [],
          why: "",
          created_at: "2026-11-26T10:00:00Z",
          updated_at: "2026-11-26T10:00:00Z",
          pending_sender: null,
          suggested_merge_thread_id: null,
        },
      ],
      customers: [
        {
          id: OTHER_CID,
          company_id: CID,
          name: "Anna",
          email: "anna@kund.se",
          phone: null,
          address: null,
          place: null,
          created_at: "2026-11-26T10:00:00Z",
          updated_at: "2026-11-26T10:00:00Z",
        },
      ],
      messages: [
        {
          id: MID,
          company_id: CID,
          thread_id: TID,
          from: "kund",
          channel: "email",
          text: "Bifogar ritning",
          delivery_status: "sent",
          sent_at: "2026-11-26T10:00:00Z",
          attachments: ["ritning.pdf"],
          attachment_files: [
            {
              name: "ritning.pdf",
              type: "application/pdf",
              size: 4096,
              path: `${CID}/inbox/x/1-ritning.pdf`,
            },
          ],
        },
      ],
      quotes: [],
      drafts: [],
      moments: [],
      audit: [],
      channels: [],
    } as unknown as WorkspaceData;

    const mapped = workspaceState(data, emptyRealState());
    const msg = mapped.threads[0]!.msgs[0]!;
    expect(msg.attachmentFiles).toEqual([
      { index: 0, name: "ritning.pdf", type: "application/pdf", size: 4096 },
    ]);
    expect("path" in msg.attachmentFiles![0]!).toBe(false);
  });
});

const baseThread: Thread = {
  id: TID,
  name: "Anna",
  ini: "A",
  ch: "email",
  chs: ["email"],
  time: "10:00",
  place: "",
  addr: "—",
  phone: "—",
  email: "anna@kund.se",
  job: "Badrum",
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
};

function renderMessage(m: InboxMessage, mode: "real" | "demo" = "real") {
  const workspace = { mode, data: { company: { name: "Firma AB" } } } as never;
  return render(
    <WorkspaceContext.Provider value={workspace}>
      <Message message={m} thread={baseThread} />
    </WorkspaceContext.Provider>,
  );
}

describe("Message clickable mail attachments", () => {
  it("opens a signed URL in a new tab with opener cleared and deduplicates the plain label", async () => {
    openMock
      .mockReset()
      .mockResolvedValue({ url: "https://storage.example/signed-pdf", name: "ritning.pdf" });
    const fakeTab = { opener: window as unknown, location: { href: "" }, close: vi.fn() };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(fakeTab as unknown as Window);

    renderMessage({
      id: MID,
      from: "kund",
      ch: "email",
      time: "10:00",
      text: "Se bifogad PDF",
      att: ["ritning.pdf"],
      attachmentFiles: [{ index: 0, name: "ritning.pdf", type: "application/pdf", size: 245760 }],
    });

    const buttons = screen.getAllByRole("button", { name: /ritning\.pdf/i });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);

    await waitFor(() => {
      expect(openMock).toHaveBeenCalledWith({ data: { messageId: MID, index: 0 } });
      expect(fakeTab.opener).toBeNull();
      expect(fakeTab.location.href).toBe("https://storage.example/signed-pdf");
    });
    openSpy.mockRestore();
  });

  it("closes the tab and shows an alert when signing fails", async () => {
    openMock.mockReset().mockRejectedValue(new Error("denied"));
    const fakeTab = { opener: window as unknown, location: { href: "" }, close: vi.fn() };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(fakeTab as unknown as Window);

    renderMessage({
      id: MID,
      from: "kund",
      ch: "email",
      time: "10:00",
      text: "Se bifogad PDF",
      att: ["ritning.pdf"],
      attachmentFiles: [{ index: 0, name: "ritning.pdf", type: "application/pdf", size: 245760 }],
    });

    fireEvent.click(screen.getByRole("button", { name: /ritning\.pdf/i }));

    await waitFor(() => {
      expect(fakeTab.close).toHaveBeenCalled();
      expect(screen.getByRole("alert").textContent).toContain("Bilagan kunde inte öppnas.");
    });
    openSpy.mockRestore();
  });

  it("keeps non-clickable attachment chips in demo mode", () => {
    renderMessage(
      { from: "kund", ch: "email", time: "10:00", text: "Demo", att: ["ritning.pdf"] },
      "demo",
    );
    expect(screen.getByText("ritning.pdf")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /ritning\.pdf/i })).toBeNull();
  });
});
