"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
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
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Keep the newest message in view as text streams in.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendMessage(e?: FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || isStreaming) return;

    setMessages([...messages, { role: "user", content: text }, { role: "assistant", content: "" }]);
    setInput("");
    setIsStreaming(true);

    try {
      // Only the new message is sent; the server keeps the conversation for this trip.
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tripId, message: text }),
      });
      if (!res.ok || !res.body) {
        throw new Error(await res.text());
      }

      // A new trip was just created: remember it, and give the page its own address.
      const savedTripId = res.headers.get("X-Trip-Id");
      if (savedTripId && savedTripId !== tripId) {
        setTripId(savedTripId);
        window.history.replaceState(null, "", `/trips/${savedTripId}`);
      }

      // Read the reply chunk by chunk and append it to the last message.
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
          <span className="trip-name">{tripTitle ?? "New trip"}</span>
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
        {messages.map((m, i) => (
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
        ))}
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
