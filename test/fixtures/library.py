from pydantic import BaseModel, Field, field_validator, computed_field, RootModel
from pydantic.dataclasses import dataclass
from typing import ClassVar, Generic, TypeVar

class CatalogItem(BaseModel):
    code: str
    count: int = 1

class Book(CatalogItem):
    title: str
    subtitle: str | None
    tags: list[str] = Field(default_factory=list)
    author: str = Field(alias='writer')
    edition: int = Field(default=1)
    rating: float = Field(...)
    category: ClassVar[str] = 'books'

    @field_validator('title')
    @classmethod
    def clean_title(cls, value: str) -> str:
        return value.strip()

    @computed_field
    @property
    def label(self) -> str:
        return self.title

@dataclass
class ReadingSession:
    minutes: int
    finished: bool = False

T = TypeVar('T')
class Envelope(BaseModel, Generic[T]):
    payload: T

class Summary(Book):
    code: ClassVar[str] = 'fixed'

class Labels(RootModel[dict[str, str]]):
    pass
