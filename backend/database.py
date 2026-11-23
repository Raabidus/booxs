from typing import AsyncGenerator
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession

from backend.config import settings
from backend.models import Base

engine = create_async_engine(settings.DATABASE_URL)
DBSession = async_sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """
    FastAPI dependency yielding a db session. The session is committed if no exception occurs, otherwise it is rolled
    back.
    """
    async with DBSession() as db:
        try:
            yield db
            await db.commit()
        except Exception:
            await db.rollback()
            raise


async def init_models() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
