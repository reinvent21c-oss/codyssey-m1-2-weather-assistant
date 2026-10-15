"""Bounded conversation documents and public API schemas."""

from typing import Annotated, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StrictStr, UUID4, field_validator, model_validator


MAX_QUESTION_CHARS = 2000
MAX_REPLY_CHARS = 4000
MAX_STORED_MESSAGES = 100
MAX_STORED_CHARS = 100000


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question: Annotated[StrictStr, Field(min_length=1, max_length=MAX_QUESTION_CHARS)]
    conversation_id: UUID4 | None = None
    outing_at: AwareDatetime | None = None

    @field_validator("question", mode="before")
    @classmethod
    def strip_question(cls, value):
        return value.strip() if isinstance(value, str) else value


class Message(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["user", "assistant"]
    content: Annotated[StrictStr, Field(min_length=1, max_length=MAX_REPLY_CHARS)]


class ConversationDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")
    created_at: AwareDatetime
    updated_at: AwareDatetime
    messages: Annotated[list[Message], Field(max_length=MAX_STORED_MESSAGES)]

    @model_validator(mode="after")
    def validate_history(self):
        if self.updated_at < self.created_at or len(self.messages) % 2:
            raise ValueError("Invalid conversation chronology")
        if any(message.role != ("user" if index % 2 == 0 else "assistant") for index, message in enumerate(self.messages)):
            raise ValueError("Messages must be ordered user/assistant pairs")
        if sum(len(message.content) for message in self.messages) > MAX_STORED_CHARS:
            raise ValueError("Conversation is too large")
        return self


class ConversationInfo(BaseModel):
    id: UUID4
    created_at: AwareDatetime
    updated_at: AwareDatetime
    message_count: int


class ConversationDetail(ConversationDocument):
    id: UUID4


class ConversationDeleted(BaseModel):
    id: UUID4
    deleted: bool


class ChatResponse(BaseModel):
    conversation_id: UUID4
    response: StrictStr
