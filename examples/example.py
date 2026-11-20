from models import Book

# Insert required arguments or all arguments.
draft = Book()


# Existing arguments are kept unchanged.
book = Book(
    title="A Guide to the Night Sky",
    author="Alex Morgan",
)
# Catch unknown field names in include/exclude.
result = book.model_dump(
    exclude={"titel"},
)
