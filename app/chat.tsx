"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { FROM_SUPPORT_LABEL, PENDING_PLANNER_HANDOFF_KEY, readHandoffNote, splitHandoff } from "@/lib/handoff";
import { signOut } from "./auth/actions";

export type ChatMessage = { role: "user" | "assistant"; content: string };

// The planner itself, shown to signed-in users. Without a tripId it's a new trip, which is
// created when the first message is sent.
export default function Chat({
  email,
  tripId: initialTripId = null,
  tripTitle = null,
  initialMessages = [],
}: {
  email: string | null;
  tripId?: string | null;
  tripTitle?: string | null;
  initialMessages?: ChatMessage[];
}) {
  const [tripId, setTripId] = useState<string | null>(initialTripId);
  const tripIdRef = useRef<string | null>(initialTripId); // current trip, for handoffs
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const messagesRef = useRef<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const startedHandoff = useRef(false);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Keep the newest message in view as text streams in.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // A handoff from Amber: start Katie on its summary, either when this page
  // loads (after being sent here) or straight away if the Help panel is open on this page.
  useEffect(() => {
    const startFrom = (summary: string) => {
      if (startedHandoff.current) return;
      startedHandoff.current = true;
      send({ handoffSummary: summary });
    };
    try {
      const pending = sessionStorage.getItem(PENDING_PLANNER_HANDOFF_KEY);
      if (pending) {
        const { summary, tripId: forTrip } = JSON.parse(pending) as { summary: string; tripId: string | null };
        if ((forTrip ?? null) === (tripIdRef.current ?? null)) {
          sessionStorage.removeItem(PENDING_PLANNER_HANDOFF_KEY);
          startFrom(summary);
        }
      }
    } catch {
      // Session storage unavailable: nothing to pick up.
    }
    const onHandoff = (e: Event) => {
      startedHandoff.current = false;
      startFrom((e as CustomEvent<{ summary: string }>).detail.summary);
    };
    window.addEventListener("planner-handoff", onHandoff);
    return () => window.removeEventListener("planner-handoff", onHandoff);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function sendMessage(e?: FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    send({ message: text });
  }

  async function send(payload: { message?: string; handoffSummary?: string }) {
    const shown = payload.handoffSummary ? `${FROM_SUPPORT_LABEL}${payload.handoffSummary}` : payload.message!;
    setMessages([...messagesRef.current, { role: "user", content: shown }, { role: "assistant", content: "" }]);
    setIsStreaming(true);
    let full = "";

    try {
      // Only the new message is sent; the server keeps the conversation for this trip.
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          payload.handoffSummary
            ? { tripId: tripIdRef.current, handoff: { summary: payload.handoffSummary } }
            : { tripId: tripIdRef.current, message: payload.message },
        ),
      });
      if (!res.ok || !res.body) {
        throw new Error(await res.text());
      }

      // A new trip was just created: remember it, and give the page its own address.
      const savedTripId = res.headers.get("X-Trip-Id");
      if (savedTripId && savedTripId !== tripIdRef.current) {
        tripIdRef.current = savedTripId;
        setTripId(savedTripId);
        window.history.replaceState(null, "", `/trips/${savedTripId}`);
      }

      // Read the reply chunk by chunk and append it to the last message.
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

      // Katie handed over: open the Help panel with her summary, remembering this trip.
      const { handoff } = splitHandoff(full);
      if (handoff?.to === "support") {
        window.dispatchEvent(
          new CustomEvent("open-help", { detail: { summary: handoff.summary, tripId: tripIdRef.current } }),
        );
      }
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : "Something went wrong.";
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = { role: "assistant", content: `⚠️ ${message}` };
        return next;
      });
    } finally {
      setIsStreaming(false);
    }
  }

  // Enter sends; Shift+Enter adds a new line.
  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <main className="chat">
      <header className="chat-header">
        <div className="header-title">
          <h1>Travel Planner</h1>
          <span className="trip-name">{tripTitle ?? (tripId ? "Your trip" : "New trip")}</span>
        </div>
        <nav className="header-links">
          {email && <span className="header-email">{email}</span>}
          <a href="/trips">Your trips</a>
          <a href="/">New trip</a>
          <a href="/preferences">Preferences</a>
          <form action={signOut}>
            <button type="submit" className="link-button">
              Sign out
            </button>
          </form>
        </nav>
      </header>

      <div className="messages">
        {messages.length === 0 && (
          <p className="empty">Where would you like to go? Ask me anything about your trip.</p>
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
            <div
              key={i}
              className={`message ${m.role}${m.role === "assistant" && !m.content ? " pending" : ""}`}
            >
              {m.role === "assistant" && m.content ? (
                // Katie's replies are markdown; links open in a new tab so the chat stays open.
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
                m.content || "Thinking…"
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <form className="composer" onSubmit={sendMessage}>
        <textarea
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type your message…"
          aria-label="Message"
        />
        <button type="submit" disabled={isStreaming || !input.trim()}>
          Send
        </button>
      </form>
    </main>
  );
}
