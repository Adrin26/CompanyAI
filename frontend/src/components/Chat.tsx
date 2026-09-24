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
const TOKEN_KEY = "companyai-admin-token";

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
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(TOKEN_KEY));
  const [showLogin, setShowLogin] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadMsg, setUploadMsg] = useState<{ text: string; isError: boolean } | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    setIsLoggingIn(true);
    const formData = new URLSearchParams();
    formData.append("username", username.trim());
    formData.append("password", password);
    try {
      const res = await fetch(`${API_URL}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData,
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || "Invalid admin credentials");
      }
      const data = await res.json();
      setToken(data.access_token);
      sessionStorage.setItem(TOKEN_KEY, data.access_token);
      setShowLogin(false);
      setUsername("");
      setPassword("");
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : "Login failed. Check credentials.");
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = () => {
    setToken(null);
    sessionStorage.removeItem(TOKEN_KEY);
    setUploadMsg(null);
    setUploadFile(null);
  };

  const handleUpload = async () => {
    if (!uploadFile || !token) return;
    const formData = new FormData();
    formData.append("file", uploadFile);
    setIsUploading(true);
    setUploadMsg({ text: "Uploading and indexing document into vector database...", isError: false });
    try {
      const res = await fetch(`${API_URL}/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || "Upload failed");
      }
      const data = await res.json();
      setUploadMsg({ text: data.message || "Document uploaded and indexed successfully!", isError: false });
      setUploadFile(null);
    } catch (err) {
      setUploadMsg({ text: err instanceof Error ? err.message : "Failed to upload document", isError: true });
    } finally {
      setIsUploading(false);
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
      const detail = err instanceof Error ? err.message : "Failed to connect to LLM backend.";
      setError(detail);
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId && !message.content
            ? { ...message, content: "I couldn't complete that reply. Please ensure the backend server and Ollama are running." }
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
          <p className="chat-subtitle">AI Assistant with vector RAG & conversation memory</p>
        </div>
        <div className="admin-header-actions">
          {!token ? (
            <button className="admin-btn" onClick={() => setShowLogin(true)}>
              Admin Login
            </button>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span className="admin-badge">Admin Connected</span>
              <button className="admin-btn" onClick={handleLogout}>
                Logout
              </button>
            </div>
          )}
        </div>
      </header>

      {token && (
        <div className="admin-upload-panel">
          <div style={{ fontWeight: 600, fontSize: "0.85rem", width: "100%", color: "#1e293b" }}>
            Add Documents to Knowledge Base (Vector DB)
          </div>
          <input
            type="file"
            accept=".pdf,.docx"
            disabled={isUploading}
            onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
          />
          <button
            className="upload-btn"
            onClick={handleUpload}
            disabled={!uploadFile || isUploading}
          >
            {isUploading ? "Processing..." : "Upload Document"}
          </button>
          {uploadMsg && (
            <div className={`upload-status ${uploadMsg.isError ? "error" : "success"}`}>
              {uploadMsg.text}
            </div>
          )}
        </div>
      )}

      {showLogin && (
        <div className="modal-overlay" onClick={() => setShowLogin(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h2>Admin Login</h2>
            <p className="modal-hint">Default credentials: <b>admin</b> / <b>password123</b></p>
            <form className="login-form" onSubmit={handleLogin}>
              <input
                type="text"
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                required
              />
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              {loginError && <div className="login-error">{loginError}</div>}
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setShowLogin(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn-primary" disabled={isLoggingIn}>
                  {isLoggingIn ? "Logging in..." : "Login"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="chat-log" ref={listRef}>
        {messages.length === 0 && (
          <p className="chat-empty">Say hi to Atom to start chatting.</p>
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
          placeholder="Type a message..."
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

