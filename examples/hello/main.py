def process(content: bytes, attributes: dict[str, str], parameters: dict[str, str]):
    prefix = parameters.get("prefix", "hello:").encode()
    return {
        "content": prefix + content.upper(),
        "attributes": {"mime.type": "text/plain"},
        "relationship": "success",
    }
