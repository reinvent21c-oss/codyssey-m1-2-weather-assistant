"""Chat and conversation endpoints; providers are initialized only on requests."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import UUID4

from backend.conversation_schemas import (
    ChatRequest, ChatResponse, ConversationDeleted, ConversationDetail, ConversationInfo,
    MAX_REPLY_CHARS, Message,
)
from backend.conversation_service import ConversationService, check_capacity
from backend.firebase import get_firestore_client
from backend.gpt_service import GPTService
from backend.services import DataService, StorageUnavailable
from backend.security import Role, require_admin
from backend.weather import SEOUL


router = APIRouter(prefix="/api", tags=["conversations"])


def get_client():
    try:
        return get_firestore_client()
    except Exception:
        raise StorageUnavailable() from None


Client = Annotated[object, Depends(get_client)]


def get_conversation_service(client: Client):
    return ConversationService(client)


def get_summary_service(client: Client):
    return DataService(client)


def get_gpt_service():
    return GPTService()


Conversations = Annotated[ConversationService, Depends(get_conversation_service)]
Summary = Annotated[DataService, Depends(get_summary_service)]
Model = Annotated[GPTService, Depends(get_gpt_service)]


def authorize_chat(request: ChatRequest, role: Role):
    if role != "admin" and request.conversation_id is not None:
        raise HTTPException(status_code=403, detail="Administrator access required.")
    return request


@router.post("/chat", response_model=ChatResponse)
def chat(request: Annotated[ChatRequest, Depends(authorize_chat)], http_request: Request,
         conversations: Conversations, data: Summary, model: Model):
    history = conversations.get(request.conversation_id).messages if request.conversation_id else []
    check_capacity(history, request.question, "x" * MAX_REPLY_CHARS)
    summary = data.summary()
    context = None
    if request.outing_at is not None:
        weather = http_request.app.state.weather_service
        selected = request.outing_at.astimezone(SEOUL)
        if selected.date() != weather.now().astimezone(SEOUL).date() or selected.second != 0 or selected.microsecond != 0:
            raise HTTPException(status_code=412, detail="Weather context is no longer valid.")
        context = weather.recommend(selected.strftime("%H:%M"), cached_only=True)
        if context["status"] != "available" or selected <= weather.now().astimezone(SEOUL):
            raise HTTPException(status_code=412, detail="Weather context is no longer valid.")
    # Invalid weather cannot consume GPT quota, invoke the model, or save a pair.
    http_request.app.state.chat_limiter.acquire()
    if context is None:
        answer = model.answer(request.question, history, summary)
    else:
        answer = model.answer(request.question, history, summary, weather_context=context)
    if request.conversation_id:
        conversations.append_pair(request.conversation_id, request.question, answer)
        document_id = request.conversation_id
    else:
        document = conversations.create([
            Message(role="user", content=request.question), Message(role="assistant", content=answer),
        ])
        document_id = document.id
    return ChatResponse(conversation_id=document_id, response=answer)


@router.post("/conversations", response_model=ConversationInfo, status_code=201, dependencies=[Depends(require_admin)])
def create_conversation(conversations: Conversations):
    document = conversations.create()
    return ConversationInfo(id=document.id, created_at=document.created_at, updated_at=document.updated_at, message_count=0)


@router.get("/conversations", response_model=list[ConversationInfo], dependencies=[Depends(require_admin)])
def list_conversations(conversations: Conversations):
    return conversations.list_conversations()


@router.get("/conversations/{id}", response_model=ConversationDetail, dependencies=[Depends(require_admin)])
def get_conversation(id: UUID4, conversations: Conversations):
    return conversations.get(id)


@router.delete("/conversations/{id}", response_model=ConversationDeleted, dependencies=[Depends(require_admin)])
def delete_conversation(id: UUID4, conversations: Conversations):
    conversations.delete(id)
    return ConversationDeleted(id=id, deleted=True)
