import { useEffect, useRef, useState, type FormEvent } from "react";
import "./Chat.css";

type Role = "user" | "assistant";

type ChatMessage = {
  id: string;
  role: Role;
  content: string;
};

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";
const THREAD_KEY = "companyai-thread-id";

function getThreadId(): string {
  const existing = sessionStorage.getItem(THREAD_KEY);
  if (existing) {
    return existing;
  }
  const id = crypto.randomUUID();
  sessionStorage.setItem(THREAD_KEY, id);
  return id;
}

async function streamAssistantReply(
  threadId: string,
  message: string,
  onToken: (token: string) => void,
): Promise<void> {
  const response = await fetch(`${API_URL}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ thread_id: threadId, message }),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Request failed (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const event of events) {
      for (const line of event.split("\n")) {
        if (!line.startsWith("data: ")) {
          continue;
        }
        const payload = JSON.parse(line.slice(6)) as {
          content?: string;
          done?: boolean;
          error?: string;
        };
        if (payload.error) {
          throw new Error(payload.error);
        }
        if (payload.done) {
          return;
        }
        if (payload.content) {
          onToken(payload.content);
        }
      }
    }
  }
}

export default function Chat() {
  const threadId = useRef(getThreadId());
  const listRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, streaming]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || streaming) {
      return;
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    };
    const assistantId = crypto.randomUUID();

    setInput("");
    setError(null);
    setStreaming(true);
    setMessages((current) => [
      ...current,
      userMessage,
      { id: assistantId, role: "assistant", content: "" },
    ]);

    try {
      await streamAssistantReply(threadId.current, text, (token) => {
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId
              ? { ...message, content: message.content + token }
              : message,
          ),
        );
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Something went wrong";
      setError(detail);
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId && !message.content
            ? { ...message, content: "I couldn't complete that reply." }
            : message,
        ),
      );
    } finally {
      setStreaming(false);
    }
  }

  return (
    <div className="chat-shell">
      <header className="chat-header">
        <div>
          <p className="chat-kicker">Company AI Chatbot</p>
          <h1>Atom</h1>
        </div>
        <p className="chat-subtitle">Atom is an AI chatbot that can help you with your questions.</p>
      </header>

      <div className="chat-log" ref={listRef}>
        {messages.length === 0 && (
          <p className="chat-empty">Say hi to Atom to get started.</p>
        )}
        {messages.map((message) => (
          <article
            key={message.id}
            className={`bubble ${message.role}`}
          >
            <span className="bubble-role">
              {message.role === "user" ? "You" : "Gemini"}
            </span>
            <p>{message.content || (streaming ? "Thinking..." : "")}</p>
          </article>
        ))}
      </div>

      {error && <p className="chat-error">{error}</p>}

      <form className="chat-form" onSubmit={handleSubmit}>
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Type a message"
          disabled={streaming}
          autoFocus
        />
        <button type="submit" disabled={streaming || !input.trim()}>
          {streaming ? "Sending..." : "Send"}
        </button>
      </form>
    </div>
  );
}
