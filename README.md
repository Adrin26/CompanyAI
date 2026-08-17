# CompanyAI Chatbot

Simple streaming chatbot: React UI, FastAPI backend, LangGraph + Gemini, LangSmith tracing.

## Prerequisites

- Python 3.12+
- [uv](https://docs.astral.sh/uv/)
- Node.js 20+
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)
- A LangSmith API key from [smith.langchain.com](https://smith.langchain.com)

## Setup

### Backend

```powershell
cd backend
copy .env.example .env
```

Edit `backend/.env` and set:

```
GEMINI_API_KEY=your-gemini-key
LANGSMITH_API_KEY=your-langsmith-key
LANGSMITH_TRACING=true
LANGSMITH_PROJECT=companyai-chatbot
```

Install and run:

```powershell
uv sync
uv run uvicorn app.main:app --reload --port 8000
```

API docs: http://localhost:8000/docs

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
3. Gemini tokens are streamed back as Server-Sent Events.
4. The same `thread_id` keeps multi-turn history until the backend process restarts.
5. LangSmith traces LangGraph/Gemini runs automatically from the env vars above.
