"use client";

import { usePathname } from "next/navigation";
import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

type HelpMessage = { role: "user" | "assistant"; content: string; failed?: boolean };

// The "Help" button in the footer, and the support chat it opens in a side panel.
// The conversation lives only in this page; nothing is stored.
export default function HelpPanel() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<HelpMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, open]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Support sits behind the access code like the rest of the app.
  if (pathname === "/access") return null;

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || isStreaming) return;

    // Earlier exchanges that failed aren't sent back to the assistant.
    const history = [...messages.filter((m) => !m.failed), { role: "user" as const, content: text }];
    setMessages([...messages, { role: "user", content: text }, { role: "assistant", content: "" }]);
    setInput("");
    setIsStreaming(true);

    try {
      const res = await fetch("/api/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.map(({ role, content }) => ({ role, content })) }),
      });
      if (!res.ok || !res.body) throw new Error(await res.text());

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          next[next.length - 1] = { ...last, content: last.content + chunk };
          return next;
        });
      }
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : "Something went wrong.";
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 2] = { ...next[next.length - 2], failed: true };
        next[next.length - 1] = { role: "assistant", content: `⚠️ ${message}`, failed: true };
        return next;
      });
    } finally {
      setIsStreaming(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <>
      <button type="button" className="link-button help-button" onClick={() => setOpen(true)} aria-expanded={open}>
        Help
      </button>

      {open && (
        <aside className="help-panel" role="dialog" aria-label="Help">
          <header className="help-header">
            <div>
              <h2>Help</h2>
              <span className="small">Questions about using Katie Travel</span>
            </div>
            <button type="button" className="link-button" onClick={() => setOpen(false)} aria-label="Close help">
              ✕
            </button>
          </header>

          <div className="messages help-messages">
            {messages.length === 0 && (
              <p className="empty">
                Ask anything about using the app: signing in, preferences, saved trips, limits or privacy. To plan a
                trip, chat with Katie instead.
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`message ${m.role}${m.role === "assistant" && !m.content ? " pending" : ""}`}>
                {m.role === "assistant" && m.content ? (
                  <div className="markdown">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm, remarkBreaks]}
                      components={{
                        a: ({ href, children }) => (
                          <a href={href} target="_blank" rel="noopener noreferrer">
                            {children}
                          </a>
                        ),
                      }}
                    >
                      {m.content}
                    </ReactMarkdown>
                  </div>
                ) : (
                  m.content || "Looking that up…"
                )}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          <form className="composer" onSubmit={send}>
            <textarea
              ref={inputRef}
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask a question…"
              aria-label="Help question"
              maxLength={4000}
            />
            <button type="submit" disabled={isStreaming || !input.trim()}>
              Send
            </button>
          </form>
        </aside>
      )}
    </>
  );
}
