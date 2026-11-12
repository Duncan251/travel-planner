"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { signOut } from "./auth/actions";

type ChatMessage = { role: "user" | "assistant"; content: string };

// The planner itself, shown to signed-in users.
export default function Chat({ email }: { email: string | null }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
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

    const history: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages([...history, { role: "assistant", content: "" }]);
    setInput("");
    setIsStreaming(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
      });
      if (!res.ok || !res.body) {
        throw new Error(await res.text());
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
        <h1>Travel Planner</h1>
        <nav className="header-links">
          {email && <span className="header-email">{email}</span>}
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
