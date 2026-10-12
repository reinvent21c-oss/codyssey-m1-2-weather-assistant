"""Five data endpoints and the lazy Firestore dependency."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from backend.firebase import get_firestore_client
from backend.schemas import DataRecord, DataSummary, DateString, DeleteResult
from backend.services import DataService, StorageUnavailable


router = APIRouter(prefix="/api/data", tags=["data"])


def get_data_service():
    try:
        return DataService(get_firestore_client())
    except Exception:
        raise StorageUnavailable() from None


Service = Annotated[DataService, Depends(get_data_service)]


@router.post("", response_model=DataRecord, status_code=201)
def create_data(record: DataRecord, service: Service):
    return service.create(record)


@router.get("", response_model=list[DataRecord])
def list_data(service: Service):
    return service.list_records()


@router.get("/summary", response_model=DataSummary)
def summarize_data(service: Service):
    return service.summary()


@router.put("/{id}", response_model=DataRecord)
def update_data(id: DateString, record: DataRecord, service: Service):
    if id != record.date:
        raise HTTPException(status_code=422, detail="Document ID and body date must match.")
    return service.update(id, record)


@router.delete("/{id}", response_model=DeleteResult)
def delete_data(id: DateString, service: Service):
    service.delete(id)
    return DeleteResult(id=id, deleted=True)
