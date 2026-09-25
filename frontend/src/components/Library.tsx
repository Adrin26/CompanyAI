import { useState, useEffect, useCallback } from "react";
import "./Library.css";

export type DocumentItem = {
  id: number;
  filename: string;
  file_type: string;
  file_size: number;
  chunk_count: number;
  uploaded_by: string;
  uploaded_at: string;
};

type UserProfile = {
  username: string;
  role: "admin" | "user";
};

type LibraryProps = {
  token: string | null;
  user: UserProfile | null;
  onSwitchToChat: () => void;
  onOpenAuthModal: () => void;
};

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr.endsWith("Z") ? dateStr : `${dateStr}Z`);
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

export default function Library({ token, user, onSwitchToChat, onOpenAuthModal }: LibraryProps) {
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [totalChunks, setTotalChunks] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Search & Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState<"ALL" | "PDF" | "DOCX">("ALL");

  // Upload state
  const [dragOver, setDragOver] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  // Delete modal state
  const [docToDelete, setDocToDelete] = useState<DocumentItem | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const fetchDocuments = useCallback(async () => {
    if (!token || user?.role !== "admin") {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/documents`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!res.ok) {
        if (res.status === 403) {
          throw new Error("Admin privileges required to access the knowledge library.");
        }
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || `Failed to fetch documents (${res.status})`);
      }

      const data = await res.json();
      setDocuments(data.documents || []);
      setTotalChunks(data.total_chunks || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load knowledge library");
    } finally {
      setIsLoading(false);
    }
  }, [token, user]);

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  const handleUploadSubmit = async (fileToUpload?: File) => {
    const file = fileToUpload || uploadFile;
    if (!file || !token) return;

    setIsUploading(true);
    setNotice(null);
    setError(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch(`${API_URL}/upload`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || "Upload failed");
      }

      const data = await res.json();
      setNotice({
        type: "success",
        text: data.message || `Successfully indexed "${file.name}" into Chroma DB.`,
      });
      setUploadFile(null);
      await fetchDocuments();
    } catch (err) {
      setNotice({
        type: "error",
        text: err instanceof Error ? err.message : "Failed to upload document",
      });
    } finally {
      setIsUploading(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!docToDelete || !token) return;

    setIsDeleting(true);
    try {
      const res = await fetch(`${API_URL}/documents/${docToDelete.id}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || "Failed to delete document");
      }

      const data = await res.json();
      setNotice({
        type: "success",
        text: data.message || `Deleted "${docToDelete.filename}" and its vector chunks.`,
      });
      setDocToDelete(null);
      await fetchDocuments();
    } catch (err) {
      setNotice({
        type: "error",
        text: err instanceof Error ? err.message : "Error deleting document",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  // Drag & drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => {
    setDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const droppedFile = e.dataTransfer.files[0];
      if (droppedFile.name.endsWith(".pdf") || droppedFile.name.endsWith(".docx")) {
        setUploadFile(droppedFile);
        handleUploadSubmit(droppedFile);
      } else {
        setNotice({
          type: "error",
          text: "Unsupported file type. Please upload a .pdf or .docx file.",
        });
      }
    }
  };

  const filteredDocs = documents.filter((doc) => {
    const matchesSearch = doc.filename.toLowerCase().includes(searchQuery.toLowerCase()) ||
      doc.uploaded_by.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesType = filterType === "ALL" || doc.file_type.toUpperCase() === filterType;
    return matchesSearch && matchesType;
  });

  const totalBytes = documents.reduce((acc, doc) => acc + (doc.file_size || 0), 0);

  if (!user || user.role !== "admin") {
    return (
      <div className="library-shell">
        <div className="library-access-denied">
          <div className="access-icon">🛡️</div>
          <h2>Admin Knowledge Base Library</h2>
          <p>
            You must be logged in as an <b>Admin</b> to view, ingest, and delete documents in the RAG knowledge vectorstore.
          </p>
          <div className="access-actions">
            {!user ? (
              <button className="btn-primary" onClick={onOpenAuthModal}>
                Sign In as Admin
              </button>
            ) : (
              <p className="access-subtext">Logged in as <b>{user.username}</b> (Standard User role).</p>
            )}
            <button className="btn-secondary" onClick={onSwitchToChat}>
              ← Back to Chat
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="library-shell">
      {/* Header section */}
      <header className="library-header">
        <div>
          <div className="library-kicker">Knowledge Management</div>
          <h1>RAG Document Library</h1>
          <p className="library-subtitle">
            Manage files indexed into the <b>Chroma DB</b> vector database for Atom retrieval.
          </p>
        </div>
        <div className="library-header-actions">
          <button className="btn-secondary" onClick={fetchDocuments} title="Refresh Document List" disabled={isLoading}>
            🔄 Refresh
          </button>
          <button className="btn-primary" onClick={onSwitchToChat}>
            💬 Back to Chat
          </button>
        </div>
      </header>

      {/* Notice alert */}
      {notice && (
        <div className={`library-alert ${notice.type}`}>
          <span>{notice.text}</span>
          <button onClick={() => setNotice(null)}>✕</button>
        </div>
      )}

      {error && (
        <div className="library-alert error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {/* Stats row */}
      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-icon">📚</span>
          <div className="stat-info">
            <span className="stat-value">{documents.length}</span>
            <span className="stat-label">Total Documents</span>
          </div>
        </div>
        <div className="stat-card">
          <span className="stat-icon">🧩</span>
          <div className="stat-info">
            <span className="stat-value">{totalChunks.toLocaleString()}</span>
            <span className="stat-label">Total Vector Chunks</span>
          </div>
        </div>
        <div className="stat-card">
          <span className="stat-icon">💾</span>
          <div className="stat-info">
            <span className="stat-value">{formatBytes(totalBytes)}</span>
            <span className="stat-label">Indexed Knowledge Size</span>
          </div>
        </div>
        <div className="stat-card highlight">
          <span className="stat-icon">⚡</span>
          <div className="stat-info">
            <span className="stat-value">Chroma DB</span>
            <span className="stat-label">Vector Store Active</span>
          </div>
        </div>
      </div>

      {/* Ingestion Dropzone */}
      <div
        className={`upload-dropzone ${dragOver ? "drag-over" : ""} ${isUploading ? "uploading" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="dropzone-icon">📥</div>
        <div className="dropzone-body">
          <h3>Upload Knowledge Document</h3>
          <p>Drag and drop a <b>PDF</b> or <b>DOCX</b> file here, or click to browse</p>
        </div>
        <div className="dropzone-actions">
          <label className="file-input-label">
            <input
              type="file"
              accept=".pdf,.docx"
              disabled={isUploading}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  setUploadFile(f);
                  handleUploadSubmit(f);
                }
              }}
            />
            {isUploading ? "Chunking & Embedding..." : "Choose File"}
          </label>
        </div>
      </div>

      {/* Search & Filter Bar */}
      <div className="library-toolbar">
        <div className="search-box">
          <span className="search-icon">🔍</span>
          <input
            type="text"
            placeholder="Search documents by filename or uploader..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className="search-clear" onClick={() => setSearchQuery("")}>
              ✕
            </button>
          )}
        </div>

        <div className="type-filters">
          <button
            className={`filter-btn ${filterType === "ALL" ? "active" : ""}`}
            onClick={() => setFilterType("ALL")}
          >
            All ({documents.length})
          </button>
          <button
            className={`filter-btn ${filterType === "PDF" ? "active" : ""}`}
            onClick={() => setFilterType("PDF")}
          >
            PDFs ({documents.filter((d) => d.file_type.toUpperCase() === "PDF").length})
          </button>
          <button
            className={`filter-btn ${filterType === "DOCX" ? "active" : ""}`}
            onClick={() => setFilterType("DOCX")}
          >
            DOCX ({documents.filter((d) => d.file_type.toUpperCase() === "DOCX").length})
          </button>
        </div>
      </div>

      {/* Documents Table / Card List */}
      <div className="documents-container">
        {isLoading ? (
          <div className="library-loading">
            <div className="spinner"></div>
            <p>Loading knowledge records from SQLite & Chroma DB...</p>
          </div>
        ) : filteredDocs.length === 0 ? (
          <div className="library-empty">
            <div className="empty-icon">📂</div>
            <h3>{searchQuery ? "No matching documents found" : "Knowledge Base is Empty"}</h3>
            <p>
              {searchQuery
                ? `No documents matched "${searchQuery}". Try clearing your search.`
                : "Upload your first PDF or DOCX file above to enable RAG answering for Atom."}
            </p>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="documents-table">
              <thead>
                <tr>
                  <th>Document Name</th>
                  <th>Format</th>
                  <th>Size</th>
                  <th>Chunks Indexed</th>
                  <th>Uploaded By</th>
                  <th>Date Added</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredDocs.map((doc) => (
                  <tr key={doc.id}>
                    <td className="doc-name-cell">
                      <span className={`file-badge ${doc.file_type.toLowerCase()}`}>
                        {doc.file_type.toUpperCase()}
                      </span>
                      <span className="doc-title" title={doc.filename}>
                        {doc.filename}
                      </span>
                    </td>
                    <td>
                      <span className="tag-format">.{doc.file_type.toLowerCase()}</span>
                    </td>
                    <td className="doc-muted">{formatBytes(doc.file_size)}</td>
                    <td>
                      <span className="chunk-badge">
                        🧩 {doc.chunk_count} {doc.chunk_count === 1 ? "chunk" : "chunks"}
                      </span>
                    </td>
                    <td>
                      <span className="uploader-badge">👤 {doc.uploaded_by}</span>
                    </td>
                    <td className="doc-muted">{formatDate(doc.uploaded_at)}</td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        className="btn-delete"
                        title="Delete document and remove all vector embeddings"
                        onClick={() => setDocToDelete(doc)}
                      >
                        🗑️ Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Confirmation Modal for Deletion */}
      {docToDelete && (
        <div className="modal-overlay" onClick={() => !isDeleting && setDocToDelete(null)}>
          <div className="modal-content delete-modal" onClick={(e) => e.stopPropagation()}>
            <div className="delete-modal-header">
              <div className="warning-icon">⚠️</div>
              <h3>Delete Document & Knowledge</h3>
            </div>
            <p className="delete-modal-text">
              Are you sure you want to delete <b>{docToDelete.filename}</b>?
            </p>
            <div className="delete-warning-box">
              <p>
                This will permanently delete the record and purge all <b>{docToDelete.chunk_count} vector chunks</b> from the Chroma DB knowledge base. Atom will no longer have access to this information.
              </p>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="btn-secondary"
                disabled={isDeleting}
                onClick={() => setDocToDelete(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-danger"
                disabled={isDeleting}
                onClick={handleConfirmDelete}
              >
                {isDeleting ? "Purging Vectors..." : "Yes, Delete Everywhere"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
