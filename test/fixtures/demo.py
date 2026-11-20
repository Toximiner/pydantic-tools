from library import Book as Novel, ReadingSession, Envelope, Summary, Labels
from pydantic import BaseModel, field_validator

book = Novel()
partial = Novel(title='Maps')
session = ReadingSession()
validated = Novel.model_validate({})
first = validated.model_dump(exclude={'missing'})
second = Novel.model_validate({}).model_dump(exclude={'missing'})
third = Novel().model_dump_json(include={'missing'})
fourth = validated.dict(exclude={'missing'})
completion = validated.model_dump(exclude={''})
known = validated.model_dump(exclude={'title', 'code'})

class Shelf(BaseModel):
    name: str

    @field_validator('absent')
    @classmethod
    def clean(cls, value):
        return value

    @field_validator('')
    @classmethod
    def other(cls, value):
        return value

    @field_validator('future', check_fields=False)
    @classmethod
    def future_field(cls, value):
        return value

class Plain:
    def dict(self, **kwargs):
        return {}
plain = Plain().dict(exclude={'not_a_model'})

envelope = Envelope[int]()
summary = Summary.model_validate({}).model_dump(exclude={'code'})
computed = Novel.model_validate({}).model_dump(include={'label'})
root = Labels({'tag': 'maps'}).model_dump(exclude={'tag'})
