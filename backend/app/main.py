import json
import os
import tempfile

from fastapi import FastAPI, Depends, HTTPException, status, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.security import OAuth2PasswordRequestForm
from langchain_community.document_loaders import PyPDFLoader, Docx2txtLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter

from app.config import settings
from app.graph import stream_reply, get_retriever, get_vectorstore, delete_document_vectors, consolidate_session
from app.schemas import ChatRequest, RegisterRequest, ConsolidateRequest
from app.auth import (
    get_current_user,
    get_admin_user,
    get_user_from_db,
    register_user,
    verify_password,
    create_access_token,
    add_document,
    get_all_documents,
    delete_document_from_db,
)

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


@app.post("/register")
async def register(req: RegisterRequest):
    user = register_user(req.username.strip(), req.password, role="user")
    access_token = create_access_token(data={"sub": user["username"]})
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "username": user["username"],
        "role": user["role"],
    }


@app.post("/login")
async def login(form_data: OAuth2PasswordRequestForm = Depends()):
    user = get_user_from_db(form_data.username.strip())
    
    if not user or not verify_password(form_data.password, user["hashed_password"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    access_token = create_access_token(data={"sub": user["username"]})
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "username": user["username"],
        "role": user["role"],
    }


@app.get("/me")
async def me(current_user: dict = Depends(get_current_user)):
    return {
        "username": current_user["username"],
        "role": current_user["role"],
    }


@app.get("/documents")
async def list_documents(current_admin: dict = Depends(get_admin_user)):
    docs = get_all_documents()
    total_chunks = sum(doc.get("chunk_count", 0) for doc in docs)
    return {
        "documents": docs,
        "total": len(docs),
        "total_chunks": total_chunks,
    }


@app.post("/upload")
async def upload_document(
    file: UploadFile = File(...), 
    current_admin: dict = Depends(get_admin_user),
):
    is_pdf = file.filename.endswith(".pdf")
    is_docx = file.filename.endswith(".docx")
    
    if not (is_pdf or is_docx):
        raise HTTPException(status_code=400, detail="Only PDF or DOCX files are supported")
        
    file_type = "PDF" if is_pdf else "DOCX"
    suffix = ".pdf" if is_pdf else ".docx"
    
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
        content = await file.read()
        temp_file.write(content)
        temp_path = temp_file.name
        file_size = len(content)
        
    try:
        if is_pdf:
            loader = PyPDFLoader(temp_path)
        else:
            loader = Docx2txtLoader(temp_path)
            
        docs = loader.load()
        text_splitter = RecursiveCharacterTextSplitter(chunk_size=500, chunk_overlap=50)
        chunks = text_splitter.split_documents(docs)
        
        # Save record in SQLite database
        doc_record = add_document(
            filename=file.filename,
            file_type=file_type,
            file_size=file_size,
            chunk_count=len(chunks),
            uploaded_by=current_admin["username"],
        )
        
        # Set precise metadata for Chroma indexing & targeted deletion
        for chunk in chunks:
            chunk.metadata["source"] = file.filename
            chunk.metadata["doc_id"] = str(doc_record["id"])
            chunk.metadata["filename"] = file.filename
            chunk.metadata["uploaded_by"] = current_admin["username"]
        
        vectorstore = get_vectorstore()
        vectorstore.add_documents(chunks)
        
        return {
            "message": f"Successfully indexed {len(chunks)} chunks from {file.filename} into knowledge base.",
            "document": doc_record,
        }
    finally:
        os.unlink(temp_path)


@app.delete("/documents/{doc_id}")
async def delete_document(doc_id: int, current_admin: dict = Depends(get_admin_user)):
    deleted_doc = delete_document_from_db(doc_id)
    if not deleted_doc:
        raise HTTPException(status_code=404, detail="Document not found")
        
    # Purge vectors from Chroma DB
    delete_document_vectors(doc_id=doc_id, filename=deleted_doc["filename"])
    
    return {
        "status": "ok",
        "message": f"Successfully removed '{deleted_doc['filename']}' and purged its vector embeddings.",
        "deleted_document": deleted_doc,
    }


@app.post("/chat/stream")
async def chat_stream(request: ChatRequest) -> StreamingResponse:
    user_id = request.user_id or "guest"

    async def event_generator():
        try:
            async for chunk in stream_reply(request.thread_id, request.message, user_id=user_id):
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


# 2, 3, 4. Session Consolidation Trigger (New Chat / Idle Timeout)
@app.post("/chat/consolidate")
async def consolidate(req: ConsolidateRequest):
    user_id = req.user_id or "guest"
    summary = await consolidate_session(thread_id=req.thread_id, user_id=user_id)
    return {
        "status": "ok",
        "saved_to_sqlite": bool(summary),
        "summary": summary,
    }

