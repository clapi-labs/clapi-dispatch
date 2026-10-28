# Engine de asignación: Python sin dependencias externas.
#   docker build -t dispatch-engine apps/engine

# Versión exacta de Python (28 de oct. de 2026).
ARG PYTHON_VERSION=3.14.4

FROM python:${PYTHON_VERSION}-alpine
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY algoritmo.py api.py ./
USER app
# El puerto lo fija docker-compose (PORT); 3003 por defecto.
CMD ["python", "api.py"]
