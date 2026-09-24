from typing import Optional
from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    thread_id: str = Field(..., min_length=1)
    message: str = Field(..., min_length=1)
    user_id: Optional[str] = "guest"


class RegisterRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=50)
    password: str = Field(..., min_length=4)


class ConsolidateRequest(BaseModel):
    thread_id: str = Field(..., min_length=1)
    user_id: Optional[str] = "guest"

