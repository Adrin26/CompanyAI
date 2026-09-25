import { useEffect, useRef, useState, type FormEvent } from "react";
import "./Chat.css";

type Role = "user" | "assistant";

type ChatMessage = {
  id: string;
  role: Role;
  content: string;
};

type UserProfile = {
  username: string;
  role: "admin" | "user";
};

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";
const THREAD_KEY = "companyai-thread-id";
const TOKEN_KEY = "companyai-auth-token";
const USER_KEY = "companyai-user-profile";
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function getOrCreateThreadId(): string {
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
  userId: string,
  onToken: (token: string) => void,
): Promise<void> {
  const response = await fetch(`${API_URL}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ thread_id: threadId, message, user_id: userId }),
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

type ChatProps = {
  onOpenLibrary?: () => void;
};

export default function Chat({ onOpenLibrary }: ChatProps = {}) {
  const [threadId, setThreadId] = useState<string>(getOrCreateThreadId);
  const listRef = useRef<HTMLDivElement>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // User & Auth states
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState<UserProfile | null>(() => {
    const saved = sessionStorage.getItem(USER_KEY);
    return saved ? JSON.parse(saved) : null;
  });

  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authTab, setAuthTab] = useState<"login" | "register">("login");
  const [usernameInput, setUsernameInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [isSubmittingAuth, setIsSubmittingAuth] = useState(false);

  // Document upload state (Admin only)
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadMsg, setUploadMsg] = useState<{ text: string; isError: boolean } | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  // Consolidate current session and reset thread
  const handleConsolidateSession = async (currentId: string, currentUser: UserProfile | null) => {
    try {
      const res = await fetch(`${API_URL}/chat/consolidate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          thread_id: currentId,
          user_id: currentUser ? currentUser.username : "guest",
        }),
      });
      const data = await res.json();
      if (currentUser && data.saved_to_sqlite) {
        setNotice("✨ Session consolidated & saved to your long-term memory.");
      } else if (!currentUser) {
        setNotice("✨ New session started. (Guest memory wiped from RAM).");
      }
    } catch (e) {
      console.error("Consolidation error:", e);
    }
  };

  // Trigger: New Chat button
  const handleNewChat = async () => {
    if (messages.length > 0) {
      await handleConsolidateSession(threadId, user);
    }
    const newId = crypto.randomUUID();
    sessionStorage.setItem(THREAD_KEY, newId);
    setThreadId(newId);
    setMessages([]);
    setError(null);
  };

  // Reset & restart idle timer (5 minutes inactivity trigger)
  const resetIdleTimer = () => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
    }
    idleTimerRef.current = setTimeout(() => {
      if (messages.length > 0) {
        handleConsolidateSession(threadId, user);
        const newId = crypto.randomUUID();
        sessionStorage.setItem(THREAD_KEY, newId);
        setThreadId(newId);
        setNotice("🕒 Session ended due to idle inactivity. Memory consolidated.");
      }
    }, IDLE_TIMEOUT_MS);
  };

  useEffect(() => {
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, []);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setIsSubmittingAuth(true);

    try {
      if (authTab === "login") {
        const formData = new URLSearchParams();
        formData.append("username", usernameInput.trim());
        formData.append("password", passwordInput);
        const res = await fetch(`${API_URL}/login`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: formData,
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.detail || "Invalid credentials");
        }
        const data = await res.json();
        const profile: UserProfile = { username: data.username, role: data.role };
        setToken(data.access_token);
        setUser(profile);
        sessionStorage.setItem(TOKEN_KEY, data.access_token);
        sessionStorage.setItem(USER_KEY, JSON.stringify(profile));
        setShowAuthModal(false);
      } else {
        const res = await fetch(`${API_URL}/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: usernameInput.trim(),
            password: passwordInput,
          }),
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.detail || "Registration failed");
        }
        const data = await res.json();
        const profile: UserProfile = { username: data.username, role: data.role };
        setToken(data.access_token);
        setUser(profile);
        sessionStorage.setItem(TOKEN_KEY, data.access_token);
        sessionStorage.setItem(USER_KEY, JSON.stringify(profile));
        setShowAuthModal(false);
      }
      setUsernameInput("");
      setPasswordInput("");
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Authentication error");
    } finally {
      setIsSubmittingAuth(false);
    }
  };

  const handleLogout = () => {
    if (messages.length > 0) {
      handleConsolidateSession(threadId, user);
    }
    setToken(null);
    setUser(null);
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
    setUploadMsg(null);
    setUploadFile(null);
    handleNewChat();
  };

  const handleUpload = async () => {
    if (!uploadFile || !token) return;
    const formData = new FormData();
    formData.append("file", uploadFile);
    setIsUploading(true);
    setUploadMsg({ text: "Indexing document into knowledge base...", isError: false });
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
      setUploadMsg({ text: data.message || "Document indexed successfully!", isError: false });
      setUploadFile(null);
    } catch (err) {
      setUploadMsg({ text: err instanceof Error ? err.message : "Upload failed", isError: true });
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

    resetIdleTimer();
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    };
    const assistantId = crypto.randomUUID();

    setInput("");
    setError(null);
    setNotice(null);
    setStreaming(true);
    setMessages((current) => [
      ...current,
      userMessage,
      { id: assistantId, role: "assistant", content: "" },
    ]);

    try {
      const currentUserId = user ? user.username : "guest";
      await streamAssistantReply(threadId, text, currentUserId, (tokenChunk) => {
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId
              ? { ...message, content: message.content + tokenChunk }
              : message,
          ),
        );
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Failed to connect to AI backend.";
      setError(detail);
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId && !message.content
            ? { ...message, content: "I couldn't complete that reply. Please check if Ollama is running." }
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
          <p className="chat-subtitle">In-RAM working memory + SQLite permanent consolidation</p>
        </div>
        <div className="header-actions">
          {onOpenLibrary && (
            <button className="btn-library-nav" onClick={onOpenLibrary} title="Open Document Knowledge Library">
              📚 Knowledge Library
            </button>
          )}
          <button className="btn-new-chat" onClick={handleNewChat} title="Consolidate & Start New Chat">
            ✨ New Chat
          </button>
          {!user ? (
            <button className="auth-btn" onClick={() => setShowAuthModal(true)}>
              Login / Sign Up
            </button>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span className={`user-badge ${user.role}`}>
                {user.role === "admin" ? "🛡️ Admin: " : "👤 User: "}
                {user.username}
              </span>
              <button className="btn-logout" onClick={handleLogout}>
                Logout
              </button>
            </div>
          )}
        </div>
      </header>

      {notice && (
        <div className="toast-notice">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} style={{ background: "none", border: "none", cursor: "pointer", fontWeight: 700 }}>✕</button>
        </div>
      )}

      {!user && (
        <div className="guest-banner">
          <span>💡 You are chatting as a <b>Guest</b> (working memory in RAM only).</span>
          <button onClick={() => setShowAuthModal(true)}>Log in to save history</button>
        </div>
      )}

      {user?.role === "admin" && (
        <div className="admin-upload-panel">
          <div style={{ fontWeight: 600, fontSize: "0.85rem", width: "100%", color: "#1e293b" }}>
            🛡️ Admin Document Knowledge Ingestion (Chroma Vector DB)
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

      {showAuthModal && (
        <div className="modal-overlay" onClick={() => setShowAuthModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-tabs">
              <button
                className={`modal-tab ${authTab === "login" ? "active" : ""}`}
                onClick={() => { setAuthTab("login"); setAuthError(null); }}
              >
                Sign In
              </button>
              <button
                className={`modal-tab ${authTab === "register" ? "active" : ""}`}
                onClick={() => { setAuthTab("register"); setAuthError(null); }}
              >
                Create Account
              </button>
            </div>

            <p className="modal-hint">
              {authTab === "login"
                ? "Sign in to persist your memory across sessions. (Admin: admin / password123)"
                : "Create a user account to remember your facts & preferences."}
            </p>

            <form className="login-form" onSubmit={handleAuthSubmit}>
              <input
                type="text"
                placeholder="Username"
                value={usernameInput}
                onChange={(e) => setUsernameInput(e.target.value)}
                autoFocus
                required
              />
              <input
                type="password"
                placeholder="Password"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                required
              />
              {authError && <div className="login-error">{authError}</div>}
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setShowAuthModal(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn-primary" disabled={isSubmittingAuth}>
                  {isSubmittingAuth
                    ? "Submitting..."
                    : authTab === "login"
                    ? "Login"
                    : "Register"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="chat-log" ref={listRef}>
        {messages.length === 0 && (
          <p className="chat-empty">
            Say hi to Atom to start chatting.
            {user ? " Your facts and preferences will be remembered." : " Login to save your preferences."}
          </p>
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


