import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { openMailAttachment } from "@/lib/mail-attachment.functions";
import {
  formatAttachmentSize,
  isImageAttachment,
  type MailAttachmentItem,
} from "@/lib/mail-attachments";
import { Button } from "@/components/ui/button";
import { Icon } from "./icon";

export function MailAttachment({
  messageId,
  file,
}: {
  messageId: string;
  file: MailAttachmentItem;
}) {
  const openFile = useServerFn(openMailAttachment);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const size = formatAttachmentSize(file.size);

  async function open() {
    if (busy) return;
    setError("");
    const tab = window.open("", "_blank");
    if (!tab) {
      setError("Tillåt nya flikar för att öppna bilagan.");
      return;
    }
    tab.opener = null;
    setBusy(true);
    try {
      const result = await openFile({ data: { messageId, index: file.index } });
      tab.location.href = result.url;
    } catch {
      tab.close();
      setError("Bilagan kunde inte öppnas.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="prototype"
        className="sent-document"
        disabled={busy}
        onClick={() => void open()}
        title={`Öppna ${file.name}`}
      >
        <span className="thumb">
          <Icon name={isImageAttachment(file.name, file.type) ? "foto" : "doc"} />
        </span>
        <span>
          {file.name}
          {size && <span className="xs muted"> · {size}</span>}
        </span>
      </Button>
      {error && (
        <p role="alert" className="xs muted mt4">
          {error}
        </p>
      )}
    </>
  );
}
