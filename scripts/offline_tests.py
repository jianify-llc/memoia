"""quick 的网络边界：捕获真实连接尝试，错误被业务捕获也不能让验证通过。"""
import socket

ATTEMPTS = []
ORIGINALS = {}


def forbidden(*args, **kwargs):
    ATTEMPTS.append("socket")
    raise RuntimeError("QUICK_NETWORK_FORBIDDEN")


def pytest_sessionstart(session):
    ATTEMPTS.clear()
    ORIGINALS.clear()
    import psycopg2
    from sqlalchemy.engine import Engine
    from redis.asyncio.connection import AbstractConnection
    for owner, name in ((socket.socket, "connect"), (socket.socket, "connect_ex"),
                        (socket, "create_connection"), (socket, "getaddrinfo"),
                        (psycopg2, "connect"), (Engine, "connect"), (AbstractConnection, "connect")):
        ORIGINALS[owner, name] = getattr(owner, name)
        setattr(owner, name, forbidden)


def pytest_sessionfinish(session, exitstatus):
    for (owner, name), method in ORIGINALS.items():
        setattr(owner, name, method)
    if ATTEMPTS:
        session.exitstatus = 1
        print("QUICK_NETWORK_FORBIDDEN: attempted real network access")
