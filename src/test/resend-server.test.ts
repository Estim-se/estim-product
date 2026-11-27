import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isResendEnabled,
  parseResendFromAddress,
  sendResendSystemEmail,
} from "@/lib/resend.server";

describe("resend.server", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses plain and display-name sender addresses and rejects header injection", () => {
    expect(parseResendFromAddress("notiser@mail.estim.se")).toBe("notiser@mail.estim.se");
    expect(parseResendFromAddress("estim <Notiser@Mail.Estim.se>")).toBe("notiser@mail.estim.se");
    expect(parseResendFromAddress("estim <notiser@mail.estim.se>\r\nBcc: x@y.se")).toBeNull();
    expect(parseResendFromAddress("inte-en-adress")).toBeNull();
    expect(parseResendFromAddress("")).toBeNull();
  });

  it("stays off by default unless flag, key and sender are all configured", () => {
    expect(isResendEnabled({})).toBe(false);
    expect(
      isResendEnabled({
        RESEND_API_KEY: "re_test",
        RESEND_FROM: "notiser@mail.estim.se",
      }),
    ).toBe(false);
    expect(
      isResendEnabled({
        RESEND_NOTIFY_ENABLED: "true",
        RESEND_API_KEY: "re_test",
        RESEND_FROM: "invalid",
      }),
    ).toBe(false);
    expect(
      isResendEnabled({
        RESEND_NOTIFY_ENABLED: "true",
        RESEND_API_KEY: "re_test",
        RESEND_FROM: "estim <notiser@mail.estim.se>",
      }),
    ).toBe(true);
  });

  it("posts to Resend with loop-prevention headers and idempotency key", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        seenUrl = String(url);
        seenInit = init;
        return new Response(JSON.stringify({ id: "re_msg_123" }), { status: 200 });
      }),
    );

    const id = await sendResendSystemEmail(
      {
        to: "Kund@Firma.se",
        subject: "Test\r\nrad",
        html: "<p>Hej</p>",
        text: "Hej",
        idempotencyKey: "draft:c1:j1:0",
      },
      {
        RESEND_API_KEY: "re_secret",
        RESEND_FROM: "estim <notiser@mail.estim.se>",
      },
    );

    expect(id).toBe("re_msg_123");
    expect(seenUrl).toBe("https://api.resend.com/emails");
    const hdrs = seenInit?.headers as Record<string, string>;
    expect(hdrs["Authorization"]).toBe("Bearer re_secret");
    expect(hdrs["Idempotency-Key"]).toBe("draft:c1:j1:0");

    const payload = JSON.parse(String(seenInit?.body)) as {
      from: string;
      to: string[];
      subject: string;
      headers: Record<string, string>;
    };
    expect(payload.from).toBe("estim <notiser@mail.estim.se>");
    expect(payload.to).toEqual(["kund@firma.se"]);
    expect(payload.subject).toBe("Test rad");
    expect(payload.headers).toEqual({
      "Auto-Submitted": "auto-generated",
      "X-Auto-Response-Suppress": "All",
      "X-Estim-System-Mail": "1",
    });
  });

  it("throws safe status codes without leaking response bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("sensitive provider detail", { status: 429 })),
    );

    await expect(
      sendResendSystemEmail(
        { to: "a@b.se", subject: "Hej", html: "<p>Hej</p>" },
        { RESEND_API_KEY: "re_secret", RESEND_FROM: "notiser@mail.estim.se" },
      ),
    ).rejects.toThrow("resend_429");
  });
});
