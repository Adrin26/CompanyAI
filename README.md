# CompanyAI Chatbot

Simple streaming chatbot: React UI, FastAPI backend, LangGraph with Gemini or local Ollama, LangSmith tracing.

## Prerequisites

- Python 3.12+
- [uv](https://docs.astral.sh/uv/)
- Node.js 20+
- Either a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey), or [Ollama](https://ollama.com) with `llama3.1:latest`
- A LangSmith API key from [smith.langchain.com](https://smith.langchain.com) (optional, for tracing)

## Setup

### Backend

```powershell
cd backend
copy .env.example .env
```

Edit `backend/.env`. If `GEMINI_API_KEY` is set, the backend uses Gemini. If it is empty, it uses local Ollama:

```
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1:latest
LANGSMITH_API_KEY=your-langsmith-key
LANGSMITH_TRACING=true
LANGSMITH_PROJECT=companyai-chatbot
```

For the Ollama fallback, pull the model first:

```powershell
ollama pull llama3.1:latest
```

Install and run:

```powershell
uv sync
uv run uvicorn app.main:app --reload --port 8000
```

API docs: http://localhost:8000/docs. `GET /health` reports which provider is active (`gemini` or `ollama`).

### Frontend

```powershell
cd frontend
copy .env.example .env
npm install
npm run dev
```

Open http://localhost:5173

## How it works

1. The browser sends `{ thread_id, message }` to `POST /chat/stream`.
2. FastAPI runs a one-node LangGraph chatbot compiled with an in-memory checkpointer.
3. Gemini is used when `GEMINI_API_KEY` is set; otherwise tokens come from local Ollama (`llama3.1:latest` by default).
4. The same `thread_id` keeps multi-turn history with long-term memory consolidation in SQLite.
5. **Knowledge Base Library**: Admins can view indexed files, chunk counts, upload new documents (`.pdf`, `.docx`), and delete existing documents along with their corresponding vector embeddings from Chroma DB.
6. LangSmith traces LangGraph runs automatically from the env vars above.
