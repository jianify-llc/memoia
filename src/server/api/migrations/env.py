# Modified for Memoia: use the renamed internal server package.
from logging.config import fileConfig
import os

from sqlalchemy import engine_from_config
from sqlalchemy import pool

from alembic import context
from memoia_server.models.database import REG
from memoia_server.models.source import SOURCE_TABLES
from memoia_server.models.projects import project_api_keys

# this is the Alembic Config object, which provides
# access to the values within the .ini file in use.
config = context.config
database_url = os.environ.get("DATABASE_URL")
if not database_url:
    raise RuntimeError("DATABASE_URL is required for explicit migrations")
config.set_main_option("sqlalchemy.url", database_url.replace("%", "%%"))

# Interpret the config file for Python logging.
# This line sets up loggers basically.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# add your model's MetaData object here
# for 'autogenerate' support
# from myapp import mymodel
# target_metadata = mymodel.Base.metadata
target_metadata = [REG.metadata]

# other values from the config, defined by the needs of env.py,
# can be acquired:
# my_important_option = config.get_main_option("my_important_option")
# ... etc.


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    This configures the context with just a URL
    and not an Engine, though an Engine is acceptable
    here as well.  By skipping the Engine creation
    we don't even need a DBAPI to be available.

    Calls to context.execute() here emit the given string to the
    script output.

    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def validate_revision_constraints(ctx, **_):
    # 同一事务连续升级时先验证延迟约束，避免待执行 trigger 阻挡下一版 ALTER TABLE。
    # 不提前提交；恢复 deferred 语义，后续失败仍回滚整条升级链。
    ctx.connection.exec_driver_sql("SET CONSTRAINTS ALL IMMEDIATE")
    ctx.connection.exec_driver_sql("SET CONSTRAINTS ALL DEFERRED")


def run_migrations_online() -> None:
    """Run migrations in 'online' mode.

    In this scenario we need to create an Engine
    and associate a connection with the context.

    """
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata,
                          version_table_schema=connection.dialect.default_schema_name,
                          on_version_apply=validate_revision_constraints)

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
