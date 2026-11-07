"""Exception-tree diagnostics shared by connector runtime operations."""


def exception_texts(error: BaseException, depth: int = 0) -> list[str]:
    """Flatten one exception, its groups, and its causes into readable text."""
    if depth > 8:
        return []
    texts = [f"{type(error).__name__}: {error}"]
    # Python 3.10 may use the ExceptionGroup backport.
    children = getattr(error, "exceptions", None)
    if isinstance(children, (list, tuple)):
        for item in children:
            texts.extend(exception_texts(item, depth + 1))
    cause = error.__cause__ or error.__context__
    if cause is not None and cause is not error:
        texts.extend(exception_texts(cause, depth + 1))
    return texts
