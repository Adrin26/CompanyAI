import json

from fastapi import FastAPI, Depends, HTTPException, status, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.security import OAuth2PasswordRequestForm
import tempfile
import os
from langchain_community.document_loaders import PyPDFLoader, Docx2txtLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter

from app.config import settings
from app.graph import stream_reply, get_retriever
from app.schemas import ChatRequest
from app.auth import get_current_user, cursor, verify_password, create_access_token

app = FastAPI(title="CompanyAI Chatbot")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "provider": settings.llm_provider}


@app.post("/login")
async def login(form_data: OAuth2PasswordRequestForm = Depends()):
    cursor.execute("SELECT username, hashed_password FROM users WHERE username = ?", (form_data.username,))
    user = cursor.fetchone()
    
    if not user or not verify_password(form_data.password, user[1]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    access_token = create_access_token(data={"sub": user[0]})
    return {"access_token": access_token, "token_type": "bearer"}


@app.post("/upload")
async def upload_document(
    file: UploadFile = File(...), 
    current_user: str = Depends(get_current_user)
):
    is_pdf = file.filename.endswith(".pdf")
    is_docx = file.filename.endswith(".docx")
    
    if not (is_pdf or is_docx):
        raise HTTPException(status_code=400, detail="Only PDF or DOCX files are supported")
        
    suffix = ".pdf" if is_pdf else ".docx"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
        content = await file.read()
        temp_file.write(content)
        temp_path = temp_file.name
        
    try:
        if is_pdf:
            loader = PyPDFLoader(temp_path)
        else:
            loader = Docx2txtLoader(temp_path)
            
        docs = loader.load()
        text_splitter = RecursiveCharacterTextSplitter(chunk_size=500, chunk_overlap=50)
        chunks = text_splitter.split_documents(docs)
        
        retriever = get_retriever()
        vectorstore = retriever.vectorstore
        vectorstore.add_documents(chunks)
        
        return {"message": f"Successfully added {len(chunks)} chunks from {file.filename} to vector DB."}
    finally:
        os.unlink(temp_path)


@app.post("/chat/stream")
async def chat_stream(request: ChatRequest) -> StreamingResponse:
    async def event_generator():
        try:
            async for chunk in stream_reply(request.thread_id, request.message):
                yield f"data: {json.dumps({'content': chunk})}\n\n"
            yield f"data: {json.dumps({'done': True})}\n\n"
        except RuntimeError as exc:
            yield f"data: {json.dumps({'error': str(exc)})}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'error': str(exc)})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
