import type { EventRow, SessionRow } from "../shared/types";

export function sessionToMarkdown(session: SessionRow, events: EventRow[], opts?: { skipHeader?: boolean }): string {
  const lines: string[] = [];
  if (!opts?.skipHeader) {
    lines.push(`# ${session.title}`);
    lines.push("");
    lines.push(`- Created: ${new Date(session.createdAt).toLocaleString()}`);
    lines.push(`- Event count: ${events.length}`);
    lines.push("");
    lines.push("## Transcript");
    lines.push("");
  }

  for (const event of events) {
    const at = new Date(event.ts).toLocaleTimeString();
    const windowPart = event.window ? ` - ${event.window}` : "";
    lines.push(`### [${at}] ${event.app}${windowPart} (${event.source})`);
    lines.push("");
    lines.push(event.text);
    lines.push("");
  }
  return lines.join("\n");
}

export function sessionToJson(session: SessionRow, events: EventRow[]): string {
  return JSON.stringify(
    {
      session: {
        id: session.id,
        createdAt: session.createdAt,
        title: session.title,
        isShared: !!session.isShared
      },
      events
    },
    null,
    2
  );
}
