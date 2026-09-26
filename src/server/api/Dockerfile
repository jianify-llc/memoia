# Modified for Memoia: use the renamed internal server package.
FROM python:3.12.14-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e
COPY --from=ghcr.io/astral-sh/uv:0.9.17@sha256:5cb6b54d2bc3fe2eb9a8483db958a0b9eebf9edff68adedb369df8e7b98711a2 /uv /uvx /bin/

ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/jianify/memoia" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.licenses="Apache-2.0"


# Set working directory
WORKDIR /app

# Copy dependency files
COPY ./pyproject.toml /app
COPY ./uv.lock /app

# Install Python dependencies using uv
RUN uv sync --frozen --no-dev --no-cache-dir

# Copy the application code
COPY ./memoia_server /app/memoia_server
COPY ./api.py /app
COPY ./LICENSE ./NOTICE /app/



# Expose port 8000 (FastAPI default)
EXPOSE 8000

# Set environment variables
ENV PYTHONUNBUFFERED=1

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD /app/.venv/bin/python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/v1/healthcheck', timeout=4)" || exit 1

# Run the FastAPI server using uvicorn
CMD ["/app/.venv/bin/uvicorn", "api:app", "--host", "0.0.0.0", "--port", "8000"]
