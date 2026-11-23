import asyncio

from backend.database import init_models


if __name__ == "__main__":
    asyncio.run(init_models())
    print("Database initialized.")
