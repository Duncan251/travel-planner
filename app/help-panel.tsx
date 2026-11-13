"use client";

import { usePathname } from "next/navigation";
import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { FROM_PLANNER_LABEL, PENDING_PLANNER_HANDOFF_KEY, readHandoffNote, splitHandoff, SUPPORT_NAME } from "@/lib/handoff";

type HelpMessage = { role: "user" | "assistant"; content: string; failed?: boolean };

// The "Help" button in the footer, and the support chat it opens in a side panel.
// The conversation lives only in this page; nothing is stored.
export default function HelpPanel() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<HelpMessage[]>([]);
  const messagesRef = useRef<HelpMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const returnTripId = useRef<string | null>(null); // the trip Katie handed over from, if any
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

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

  // Katie handed over: open the panel and start with her summary, so Amber
  // can answer it straight away.
  useEffect(() => {
    const onOpenHelp = (e: Event) => {
      const { summary, tripId } = (e as CustomEvent<{ summary: string; tripId: string | null }>).detail;
      returnTripId.current = tripId;
      setOpen(true);
      send(`${FROM_PLANNER_LABEL}${summary}`);
    };
    window.addEventListener("open-help", onOpenHelp);
    return () => window.removeEventListener("open-help", onOpenHelp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Support sits behind the access code like the rest of the app.
  if (pathname === "/access") return null;

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    send(text);
  }

  async function send(text: string) {
    // Earlier exchanges that failed aren't sent back to the assistant.
    const current = messagesRef.current;
    const history = [...current.filter((m) => !m.failed), { role: "user" as const, content: text }];
    setMessages([...current, { role: "user", content: text }, { role: "assistant", content: "" }]);
    setIsStreaming(true);
    let full = "";

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
        full += decoder.decode(value, { stream: true });
        const visible = splitHandoff(full).visible;
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = { role: "assistant", content: visible };
          return next;
        });
      }

      const { handoff } = splitHandoff(full);
      if (handoff?.to === "planner") goToKatie(handoff.summary);
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

  // Amber handed over to Katie: back to the trip they came from (or the trip
  // page they're on), otherwise a new trip, with the summary waiting for her.
  function goToKatie(summary: string) {
    const fromPath = window.location.pathname.match(/^\/trips\/([0-9a-f-]{36})$/)?.[1] ?? null;
    const tripId = returnTripId.current ?? fromPath;
    const target = tripId ? `/trips/${tripId}` : "/";
    try {
      sessionStorage.setItem(PENDING_PLANNER_HANDOFF_KEY, JSON.stringify({ summary, tripId }));
    } catch {
      // Without session storage the summary can't travel; Katie will simply start fresh.
    }
    setTimeout(() => {
      if (window.location.pathname === target) {
        sessionStorage.removeItem(PENDING_PLANNER_HANDOFF_KEY);
        setOpen(false);
        window.dispatchEvent(new CustomEvent("planner-handoff", { detail: { summary } }));
      } else {
        window.location.href = target;
      }
    }, 1200); // a moment to read the handover message
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <>
      <button type="button" className="link-button help-button" onClick={() => setOpen(true)} aria-expanded={open}>
        Help
      </button>

      {open && (
        <aside className="help-panel" role="dialog" aria-label={`Help from ${SUPPORT_NAME}`}>
          <header className="help-header">
            <div>
              <h2>{SUPPORT_NAME}</h2>
              <span className="small">Your support assistant for using Katie Travel</span>
            </div>
            <button type="button" className="link-button" onClick={() => setOpen(false)} aria-label="Close help">
              ✕
            </button>
          </header>

          <div className="messages help-messages">
            {messages.length === 0 && (
              <p className="empty">
                Hi, I&apos;m {SUPPORT_NAME}. Ask me anything about using the app: signing in, preferences, saved trips,
                limits or privacy. To plan a trip, chat with Katie instead.
              </p>
            )}
            {messages.map((m, i) => {
              const note = m.role === "user" ? readHandoffNote(m.content) : null;
              if (note) {
                return (
                  <p key={i} className="handoff-note">
                    Passed from {note.from}: {note.summary}
                  </p>
                );
              }
              return (
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
              );
            })}
            <div ref={bottomRef} />
          </div>

          <form className="composer" onSubmit={submit}>
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
