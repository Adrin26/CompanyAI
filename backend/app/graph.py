from typing import Annotated, AsyncIterator, TypedDict, Optional
from langchain_core.messages import AIMessageChunk, HumanMessage, SystemMessage, BaseMessage
from langchain_google_genai import ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings
from langchain_ollama import ChatOllama, OllamaEmbeddings
from langchain_chroma import Chroma
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from app.config import settings
from app.auth import get_user_memories, save_user_memory
from redis import Redis
from langchain_community.cache import RedisCache
from langchain_core.globals import set_llm_cache

try:
    redis_client = Redis(host='localhost', port=6379, db=0, socket_connect_timeout=1)
    redis_client.ping()
    set_llm_cache(RedisCache(redis_client))
except Exception:
    pass


class ChatState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
    user_id: Optional[str]


def _text_from_content(content: object) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str):
                    parts.append(text)
            elif hasattr(item, "text") and isinstance(item.text, str):
                parts.append(item.text)
        return "".join(parts)
    return ""


def _build_llm():
    if settings.use_gemini:
        return ChatGoogleGenerativeAI(
            model=settings.gemini_model,
            api_key=settings.gemini_api_key,
            temperature=0.7,
        )
    return ChatOllama(
        model=settings.ollama_model,
        base_url=settings.ollama_base_url,
        temperature=0.7,
    )


def get_embedding_model():
    if settings.use_gemini:
        return GoogleGenerativeAIEmbeddings(
            model="models/text-embedding-004",
            google_api_key=settings.gemini_api_key,
        )
    return OllamaEmbeddings(
        model="mxbai-embed-large:latest",
        base_url=settings.ollama_base_url,
    )


def get_vectorstore():
    embedding_model = get_embedding_model()
    CHROMA_DIR = "./chroma_db"
    # Separate collections by provider to prevent vector dimension mismatch (768 vs 1024)
    provider = "gemini" if settings.use_gemini else "ollama"
    COLLECTION = f"antigravity_knowledge_{provider}"
    
    return Chroma(
        persist_directory=CHROMA_DIR,
        collection_name=COLLECTION,
        embedding_function=embedding_model
    )


def get_retriever():
    vector_db = get_vectorstore()
    return vector_db.as_retriever(search_kwargs={"k": 3})


def delete_document_vectors(doc_id: int, filename: str):
    vector_db = get_vectorstore()
    # Delete chunks matching doc_id or source filename from Chroma
    try:
        vector_db._collection.delete(where={"doc_id": str(doc_id)})
    except Exception as e:
        print(f"Notice during vector deletion by doc_id: {e}")
    try:
        vector_db._collection.delete(where={"source": filename})
    except Exception as e:
        print(f"Notice during vector deletion by source: {e}")


# 1. Active Chat (Fast & Light): MemorySaver keeps active conversations instantly in RAM
memory_saver = MemorySaver()


def _build_graph():
    llm = _build_llm()
    retriever = get_retriever()

    async def chatbot(state: ChatState) -> dict:
        user_id = state.get("user_id") or "guest"
        messages = state["messages"]
        last_message = messages[-1].content if messages else ""
        
        # RAG context retrieval
        context = ""
        if isinstance(last_message, str) and last_message.strip():
            try:
                docs = await retriever.ainvoke(last_message)
                context = "\n\n".join([doc.page_content for doc in docs])
            except Exception:
                context = ""

        # Long-term consolidated memory retrieval from SQLite (for logged-in users)
        memory_context = ""
        if user_id and user_id not in ("guest", "anonymous"):
            past_memories = get_user_memories(user_id, limit=4)
            if past_memories:
                memory_bullets = "\n".join([f"- {m}" for m in past_memories])
                memory_context = f"\nWhat you remember about this user from previous sessions:\n{memory_bullets}\n"

        system_prompt = (
            f"You are a helpful and intelligent assistant named Atom.\n"
            f"{memory_context}"
            f"{f'Relevant document context:\n{context}\n' if context else ''}"
            f"""Answer concisely, accurately, and politely. Only Answer based on the documents given.
            DON'T HALLUCINATE. If you don't have the information just say its not in your knowledge base."""
        )

        messages_to_llm = [SystemMessage(content=system_prompt)] + list(messages)
        response = await llm.ainvoke(messages_to_llm)
        return {"messages": [response]}

    builder = StateGraph(ChatState)
    builder.add_node("chatbot", chatbot)
    builder.add_edge(START, "chatbot")
    builder.add_edge("chatbot", END)
    return builder.compile(checkpointer=memory_saver)


_graph = None


def get_graph():
    global _graph
    if _graph is None:
        _graph = _build_graph()
    return _graph


async def stream_reply(thread_id: str, message: str, user_id: str = "guest") -> AsyncIterator[str]:
    graph = get_graph()
    config = {"configurable": {"thread_id": thread_id}}
    async for token, metadata in graph.astream(
        {"messages": [HumanMessage(content=message)], "user_id": user_id},
        config=config,
        stream_mode="messages",
    ):
        if metadata.get("langgraph_node") != "chatbot":
            continue
        if not isinstance(token, AIMessageChunk):
            continue
        text = _text_from_content(token.content)
        if text:
            yield text


# 3 & 4. Consolidation & Permanent Save to SQLite, then wiping RAM
async def consolidate_session(thread_id: str, user_id: str = "guest") -> Optional[str]:
    config = {"configurable": {"thread_id": thread_id}}
    tuple_state = memory_saver.get_tuple(config)
    
    summary = None
    if tuple_state and "channel_values" in tuple_state.checkpoint:
        messages = tuple_state.checkpoint["channel_values"].get("messages", [])
        
        # Only summarize and persist if this is an authenticated user with active messages
        if user_id and user_id not in ("guest", "anonymous") and len(messages) >= 2:
            formatted_history = []
            for msg in messages:
                role = "User" if isinstance(msg, HumanMessage) or getattr(msg, "type", "") == "human" else "Atom"
                content = _text_from_content(msg.content) if hasattr(msg, "content") else str(msg)
                if content:
                    formatted_history.append(f"{role}: {content}")
            
            if formatted_history:
                chat_text = "\n".join(formatted_history)
                llm = _build_llm()
                prompt = (
                    "Summarize the key facts, user preferences, user traits, and decisions from this chat session "
                    "concisely in 1-3 bullet points so you can remember them in future sessions. "
                    "If no noteworthy facts or preferences were shared, reply with 'NONE'.\n\n"
                    f"Chat History:\n{chat_text}\n\nSummary:"
                )
                try:
                    response = await llm.ainvoke([HumanMessage(content=prompt)])
                    summary_text = _text_from_content(response.content).strip()
                    if summary_text and "NONE" not in summary_text.upper():
                        save_user_memory(user_id, summary_text)
                        summary = summary_text
                except Exception as e:
                    print(f"Error consolidating session memory: {e}")

    # Wipe the raw chat log completely from MemorySaver in RAM
    keys_to_delete = [k for k in memory_saver.storage.keys() if thread_id in str(k)]
    for k in keys_to_delete:
        try:
            del memory_saver.storage[k]
        except KeyError:
            pass

    return summary


