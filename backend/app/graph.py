from typing import Annotated, AsyncIterator, TypedDict

from langchain_core.messages import AIMessageChunk, HumanMessage
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_ollama import ChatOllama
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from app.config import settings


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


def _build_graph():
    llm = _build_llm()

    def chatbot(state: ChatState) -> dict:
        return {"messages": [llm.invoke(state["messages"])]}

    builder = StateGraph(ChatState)
    builder.add_node("chatbot", chatbot)
    builder.add_edge(START, "chatbot")
    builder.add_edge("chatbot", END)
    return builder.compile(checkpointer=MemorySaver())


_graph = None


def get_graph():
    global _graph
    if _graph is None:
        _graph = _build_graph()
    return _graph


async def stream_reply(thread_id: str, message: str) -> AsyncIterator[str]:
    graph = get_graph()
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
