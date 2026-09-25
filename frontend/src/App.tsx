import { useState, useEffect } from "react";
import Chat from "./components/Chat.tsx";
import Library from "./components/Library.tsx";

const TOKEN_KEY = "companyai-auth-token";
const USER_KEY = "companyai-user-profile";

type UserProfile = {
  username: string;
  role: "admin" | "user";
};

export default function App() {
  const [currentView, setCurrentView] = useState<"chat" | "library">("chat");
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState<UserProfile | null>(() => {
    const saved = sessionStorage.getItem(USER_KEY);
    return saved ? JSON.parse(saved) : null;
  });

  const syncAuth = () => {
    const savedToken = sessionStorage.getItem(TOKEN_KEY);
    const savedUser = sessionStorage.getItem(USER_KEY);
    setToken(savedToken);
    setUser(savedUser ? JSON.parse(savedUser) : null);
  };

  useEffect(() => {
    syncAuth();
    window.addEventListener("storage", syncAuth);
    return () => window.removeEventListener("storage", syncAuth);
  }, [currentView]);

  return (
    <div className="app-root">
      {currentView === "chat" ? (
        <Chat
          onOpenLibrary={() => {
            syncAuth();
            setCurrentView("library");
          }}
        />
      ) : (
        <Library
          token={token}
          user={user}
          onSwitchToChat={() => {
            syncAuth();
            setCurrentView("chat");
          }}
          onOpenAuthModal={() => {
            syncAuth();
            setCurrentView("chat");
          }}
        />
      )}
    </div>
  );
}
