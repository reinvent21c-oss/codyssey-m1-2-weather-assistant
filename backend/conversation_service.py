"""Conversation storage with atomic pair appends and bounded documents."""

from datetime import datetime, timezone
from uuid import uuid4

from firebase_admin import firestore

from backend.conversation_schemas import (
    ConversationDetail, ConversationDocument, ConversationInfo, MAX_STORED_CHARS,
    MAX_STORED_MESSAGES, Message,
)
from backend.services import StorageUnavailable


class ConversationNotFound(Exception):
    pass


class ConversationLimitReached(Exception):
    pass


def check_capacity(messages, question, answer):
    if len(messages) + 2 > MAX_STORED_MESSAGES or sum(len(message.content) for message in messages) + len(question) + len(answer) > MAX_STORED_CHARS:
        raise ConversationLimitReached()


class ConversationService:
    def __init__(self, client):
        self.client = client

    def _reference(self, document_id):
        return self.client.collection("conversations").document(str(document_id))

    def create(self, messages=None):
        try:
            now = datetime.now(timezone.utc)
            document_id = str(uuid4())
            document = ConversationDocument(created_at=now, updated_at=now, messages=messages or [])
            self._reference(document_id).create(document.model_dump())
            return ConversationDetail(id=document_id, **document.model_dump())
        except Exception:
            raise StorageUnavailable() from None

    def get(self, document_id):
        try:
            snapshot = self._reference(document_id).get()
            if not snapshot.exists:
                raise ConversationNotFound()
            return ConversationDetail(id=str(document_id), **snapshot.to_dict())
        except ConversationNotFound:
            raise
        except Exception:
            raise StorageUnavailable() from None

    def list_conversations(self):
        try:
            result = []
            for snapshot in self.client.collection("conversations").stream():
                document = ConversationDetail(id=snapshot.id, **snapshot.to_dict())
                result.append(ConversationInfo(
                    id=document.id, created_at=document.created_at, updated_at=document.updated_at,
                    message_count=len(document.messages),
                ))
            return sorted(result, key=lambda item: (item.updated_at, item.created_at, str(item.id)), reverse=True)
        except Exception:
            raise StorageUnavailable() from None

    def append_pair(self, document_id, question, answer):
        try:
            reference = self._reference(document_id)

            @firestore.transactional
            def append(transaction):
                snapshot = reference.get(transaction=transaction)
                if not snapshot.exists:
                    raise ConversationNotFound()
                document = ConversationDocument.model_validate(snapshot.to_dict())
                check_capacity(document.messages, question, answer)
                messages = document.messages + [Message(role="user", content=question), Message(role="assistant", content=answer)]
                updated = max(datetime.now(timezone.utc), document.updated_at)
                # Read fresh on every SDK transaction retry; never overwrite a stale history.
                transaction.update(reference, {
                    "messages": [message.model_dump() for message in messages], "updated_at": updated,
                })

            append(self.client.transaction())
        except (ConversationNotFound, ConversationLimitReached):
            raise
        except Exception:
            raise StorageUnavailable() from None

    def delete(self, document_id):
        try:
            reference = self._reference(document_id)

            @firestore.transactional
            def delete_existing(transaction):
                if not reference.get(transaction=transaction).exists:
                    raise ConversationNotFound()
                transaction.delete(reference)

            delete_existing(self.client.transaction())
        except ConversationNotFound:
            raise
        except Exception:
            raise StorageUnavailable() from None
