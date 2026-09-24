from typing import Annotated, AsyncIterator, TypedDict
import aiosqlite

from langchain_core.messages import AIMessageChunk, HumanMessage, SystemMessage
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_ollama import ChatOllama, OllamaEmbeddings
from langchain_chroma import Chroma
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from app.config import settings
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
    messages: Annotated[list, add_messages]


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


def get_retriever():
    embedding_model = OllamaEmbeddings(
        model="mxbai-embed-large:latest",
        base_url=settings.ollama_base_url,
    )
    CHROMA_DIR = "./chroma_db"
    COLLECTION = "antigravity_knowledge"
    
    vector_db = Chroma(
        persist_directory=CHROMA_DIR,
        collection_name=COLLECTION,
        embedding_function=embedding_model
    )
    return vector_db.as_retriever(search_kwargs={"k": 3})


def _build_graph(checkpointer):
    llm = _build_llm()
    retriever = get_retriever()

    async def chatbot(state: ChatState) -> dict:
        last_message = state["messages"][-1].content
        if isinstance(last_message, str):
            try:
                docs = await retriever.ainvoke(last_message)
                context = "\n\n".join([doc.page_content for doc in docs])
            except Exception:
                context = ""
        else:
            context = ""
            
        system_msg = SystemMessage(
            content=f"You are a helpful assistant. Use the following context to answer if relevant:\n\n{context}"
        )
        
        messages_to_llm = [system_msg] + state["messages"]
        response = await llm.ainvoke(messages_to_llm)
        return {"messages": [response]}

    builder = StateGraph(ChatState)
    builder.add_node("chatbot", chatbot)
    builder.add_edge(START, "chatbot")
    builder.add_edge("chatbot", END)
    return builder.compile(checkpointer=checkpointer)


_graph = None
_conn = None


async def get_graph():
    global _graph, _conn
    if _graph is None:
        _conn = await aiosqlite.connect("antigravity_data.db")
        checkpointer = AsyncSqliteSaver(_conn)
        await checkpointer.setup()
        _graph = _build_graph(checkpointer)
    return _graph


async def stream_reply(thread_id: str, message: str) -> AsyncIterator[str]:
    graph = await get_graph()
    config = {"configurable": {"thread_id": thread_id}}
    async for token, metadata in graph.astream(
        {"messages": [HumanMessage(content=message)]},
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

