import io
import pandas as pd


def process(content, attributes, parameters):
    text = content.decode("utf-8")

    df = pd.read_json(io.StringIO(text))

    return {
        "content": df.to_csv(index=False).encode("utf-8"),
        "attributes": {
            "mime.type": "text/csv",
        },
        "relationship": "success",
    }

