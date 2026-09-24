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

  // Admin states
  const [token, setToken] = useState<string | null>(null);
  const [showLogin, setShowLogin] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadMsg, setUploadMsg] = useState("");

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const formData = new URLSearchParams();
    formData.append('username', username);
    formData.append('password', password);
    try {
      const res = await fetch(`${API_URL}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData
      });
      if (!res.ok) throw new Error("Login failed");
      const data = await res.json();
      setToken(data.access_token);
      setShowLogin(false);
    } catch (err) {
      alert("Login Failed");
    }
  };

  const handleUpload = async () => {
    if (!uploadFile || !token) return;
    const formData = new FormData();
    formData.append("file", uploadFile);
    setUploadMsg("Uploading...");
    try {
      const res = await fetch(`${API_URL}/upload`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` },
        body: formData
      });
      if (!res.ok) throw new Error("Upload failed");
      const data = await res.json();
      setUploadMsg(data.message);
    } catch (err) {
      setUploadMsg("Upload failed");
    }
  };

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
      <header className="chat-header" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <div>
          <p className="chat-kicker">Company AI Chatbot</p>
          <h1>Atom</h1>
          <p className="chat-subtitle">Atom is an AI chatbot that can help you with your questions.</p>
        </div>
        <div>
          {!token ? (
            <button onClick={() => setShowLogin(!showLogin)} style={{ padding: '8px 16px', borderRadius: '8px', cursor: 'pointer' }}>
              Admin Login
            </button>
          ) : (
            <div style={{ padding: '8px', border: '1px solid #ccc', borderRadius: '8px' }}>
              <input type="file" accept=".pdf,.docx" onChange={(e) => setUploadFile(e.target.files?.[0] || null)} />
              <button onClick={handleUpload} style={{ padding: '4px 8px', marginLeft: '8px' }}>Upload Docs</button>
              {uploadMsg && <div style={{ fontSize: '12px', marginTop: '4px' }}>{uploadMsg}</div>}
            </div>
          )}
        </div>
      </header>

      {showLogin && (
        <div style={{ padding: '16px', background: '#f5f5f5', borderBottom: '1px solid #ccc' }}>
          <form onSubmit={handleLogin} style={{ display: 'flex', gap: '8px' }}>
            <input type="text" placeholder="Admin Username" value={username} onChange={e => setUsername(e.target.value)} required />
            <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required />
            <button type="submit">Login</button>
          </form>
        </div>
      )}

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
              {message.role === "user" ? "You" : "Atom"}
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
