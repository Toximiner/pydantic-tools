from pydantic import (
    BaseModel, Field, field_validator,
)

class Book(BaseModel):
    title: str
    author: str
    pages: int = 100
    tags: list[str] = Field(default_factory=list)

    @field_validator("title")
    @classmethod
    def clean_title(cls, value: str) -> str:
        return value.strip()
